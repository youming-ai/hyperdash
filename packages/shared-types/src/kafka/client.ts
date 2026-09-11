import { type Consumer, Kafka, type KafkaMessage, type Producer, type SASLOptions } from 'kafkajs';

export interface KafkaConfig {
  brokers: string[];
  clientId: string;
  ssl?: boolean;
  sasl?: SASLOptions;
  connectionTimeout?: number;
  requestTimeout?: number;
  retry?: {
    initialRetryTime: number;
    retries: number;
  };
}

export interface ProducerConfig {
  ack?: number;
  timeout?: number;
  compression?: number;
  maxInFlightRequests?: number;
  idempotent?: boolean;
}

export interface ConsumerConfig {
  groupId: string;
  sessionTimeout?: number;
  heartbeatInterval?: number;
  maxWaitTimeInMs?: number;
  allowAutoTopicCreation?: boolean;
  fromBeginning?: boolean;
}

export class KafkaManager {
  private kafka: Kafka;
  private producer: Producer | null = null;
  private consumers: Map<string, Consumer> = new Map();
  private isInitialized = false;
  private config: KafkaConfig;

  constructor(config: KafkaConfig) {
    this.config = {
      connectionTimeout: 10000,
      requestTimeout: 30000,
      retry: {
        initialRetryTime: 100,
        retries: 8,
      },
      ...config,
    };

    this.kafka = new Kafka({
      clientId: this.config.clientId,
      brokers: this.config.brokers,
      ssl: this.config.ssl,
      sasl: this.config.sasl,
      connectionTimeout: this.config.connectionTimeout,
      requestTimeout: this.config.requestTimeout,
      retry: this.config.retry,
    });
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      console.log('Initializing Kafka manager...');

      // Test connection
      const admin = this.kafka.admin();
      await admin.connect();
      console.log('✅ Kafka admin connection successful');
      await admin.disconnect();

      // Initialize producer
      await this.initializeProducer();

      this.isInitialized = true;
      console.log('✅ Kafka manager initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize Kafka manager:', error);
      throw new Error(
        `Kafka initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  private async initializeProducer(config: ProducerConfig = {}): Promise<void> {
    const producerConfig = {
      ack: -1, // Wait for all in-sync replicas
      timeout: 30000,
      compression: 2, // gzip
      maxInFlightRequests: 1,
      idempotent: true,
      ...config,
    };

    this.producer = this.kafka.producer(producerConfig);

    await this.producer.connect();
    console.log('✅ Kafka producer connected');

    // Handle producer events
    this.producer.on('producer.connect', () => {
      console.log('🔌 Kafka producer connected');
    });

    this.producer.on('producer.disconnect', () => {
      console.log('🔌 Kafka producer disconnected');
    });

    this.producer.on('producer.network.request_timeout', (payload) => {
      console.warn('⚠️ Kafka producer request timeout:', payload);
    });
  }

  // Send a single message
  async sendMessage<T>({
    topic,
    message,
    key,
    headers,
    partition,
  }: {
    topic: string;
    message: T;
    key?: string;
    headers?: Record<string, string>;
    partition?: number;
  }): Promise<void> {
    if (!this.producer) {
      throw new Error('Producer not initialized. Call initialize() first.');
    }

    try {
      const serializedMessage = JSON.stringify(message);

      await this.producer.send({
        topic,
        messages: [
          {
            key,
            value: serializedMessage,
            headers,
            partition,
            timestamp: Date.now().toString(),
          },
        ],
      });

      console.log(`📤 Sent message to topic ${topic}${key ? ` (key: ${key})` : ''}`);
    } catch (error) {
      console.error(`❌ Failed to send message to topic ${topic}:`, error);
      throw error;
    }
  }

  // Send multiple messages in batch
  async sendBatch<T>({
    topicMessages,
  }: {
    topicMessages: Array<{
      topic: string;
      messages: Array<{
        key?: string;
        value: T;
        headers?: Record<string, string>;
        partition?: number;
      }>;
    }>;
  }): Promise<void> {
    if (!this.producer) {
      throw new Error('Producer not initialized. Call initialize() first.');
    }

    try {
      const batchMessages = topicMessages.map(({ topic, messages }) => ({
        topic,
        messages: messages.map(({ key, value, headers, partition }) => ({
          key,
          value: JSON.stringify(value),
          headers,
          partition,
          timestamp: Date.now().toString(),
        })),
      }));

      await this.producer.sendBatch({ topicMessages: batchMessages });

      const totalMessages = topicMessages.reduce((sum, { messages }) => sum + messages.length, 0);
      console.log(`📤 Sent batch of ${totalMessages} messages to ${topicMessages.length} topics`);
    } catch (error) {
      console.error('❌ Failed to send batch messages:', error);
      throw error;
    }
  }

  // Create and connect a consumer
  async createConsumer({
    config,
    topics,
    messageHandler,
  }: {
    config: ConsumerConfig;
    topics: string[];
    messageHandler: (
      message: KafkaMessage,
      topic: string,
      partition: number,
      offset: string,
    ) => Promise<void>;
  }): Promise<string> {
    const consumerId = `${config.groupId}-${Date.now()}`;

    try {
      const consumer = this.kafka.consumer({
        groupId: config.groupId,
        sessionTimeout: config.sessionTimeout || 30000,
        heartbeatInterval: config.heartbeatInterval || 3000,
        maxWaitTimeInMs: config.maxWaitTimeInMs || 5000,
        allowAutoTopicCreation: config.allowAutoTopicCreation || false,
      });

      await consumer.connect();
      console.log(`✅ Consumer ${consumerId} connected`);

      await consumer.subscribe({ topics, fromBeginning: config.fromBeginning || false });
      console.log(`✅ Consumer ${consumerId} subscribed to topics: [${topics.join(', ')}]`);

      // Start consuming messages
      await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          try {
            await messageHandler(message, topic, partition, message.offset);
          } catch (error) {
            console.error(`❌ Error processing message from topic ${topic}:`, error);
            // In production, you might want to send this to a dead-letter queue
          }
        },
      });

      // Store consumer reference
      this.consumers.set(consumerId, consumer);

      // Handle consumer events
      consumer.on('consumer.connect', () => {
        console.log(`🔌 Consumer ${consumerId} connected`);
      });

      consumer.on('consumer.disconnect', () => {
        console.log(`🔌 Consumer ${consumerId} disconnected`);
      });

      consumer.on('consumer.crash', (error) => {
        console.error(`💥 Consumer ${consumerId} crashed:`, error);
      });

      console.log(`✅ Consumer ${consumerId} created and running`);
      return consumerId;
    } catch (error) {
      console.error(`❌ Failed to create consumer ${consumerId}:`, error);
      throw error;
    }
  }

  // Stop a specific consumer
  async stopConsumer(consumerId: string): Promise<void> {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) {
      throw new Error(`Consumer ${consumerId} not found`);
    }

    try {
      await consumer.disconnect();
      this.consumers.delete(consumerId);
      console.log(`✅ Consumer ${consumerId} stopped`);
    } catch (error) {
      console.error(`❌ Failed to stop consumer ${consumerId}:`, error);
      throw error;
    }
  }

  // Stop all consumers
  async stopAllConsumers(): Promise<void> {
    const consumerIds = Array.from(this.consumers.keys());

    await Promise.all(
      consumerIds.map((id) =>
        this.stopConsumer(id).catch((error) =>
          console.error(`❌ Failed to stop consumer ${id}:`, error),
        ),
      ),
    );

    console.log('✅ All consumers stopped');
  }

  // Create a topic
  async createTopic({
    topic,
    partitions = 1,
    replicas = 1,
    configEntries = [],
  }: {
    topic: string;
    partitions?: number;
    replicas?: number;
    configEntries?: Array<{ name: string; value: string }>;
  }): Promise<void> {
    const admin = this.kafka.admin();

    try {
      await admin.connect();

      await admin.createTopics({
        topics: [
          {
            topic,
            numPartitions: partitions,
            replicationFactor: replicas,
            configEntries,
          },
        ],
      });

      console.log(`✅ Created topic: ${topic} (${partitions} partitions, ${replicas} replicas)`);
    } catch (error: any) {
      if (error.type === 'TOPIC_ALREADY_EXISTS') {
        console.log(`ℹ️ Topic ${topic} already exists`);
      } else {
        console.error(`❌ Failed to create topic ${topic}:`, error);
        throw error;
      }
    } finally {
      await admin.disconnect();
    }
  }

  // List topics
  async listTopics(): Promise<string[]> {
    const admin = this.kafka.admin();

    try {
      await admin.connect();
      const metadata = await admin.fetchTopicMetadata();
      return metadata.topics.map((topic) => topic.name);
    } finally {
      await admin.disconnect();
    }
  }

  // Get topic metadata
  async getTopicMetadata(topic: string): Promise<any> {
    const admin = this.kafka.admin();

    try {
      await admin.connect();
      const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
      return metadata.topics.find((t) => t.name === topic);
    } finally {
      await admin.disconnect();
    }
  }

  // Health check
  async healthCheck(): Promise<{ status: 'healthy' | 'unhealthy'; error?: string }> {
    try {
      const admin = this.kafka.admin();
      await admin.connect();
      await admin.disconnect();
      return { status: 'healthy' };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // Graceful shutdown
  async close(): Promise<void> {
    try {
      console.log('Shutting down Kafka manager...');

      // Stop all consumers
      await this.stopAllConsumers();

      // Disconnect producer
      if (this.producer) {
        await this.producer.disconnect();
        this.producer = null;
      }

      this.isInitialized = false;
      console.log('✅ Kafka manager shut down successfully');
    } catch (error) {
      console.error('❌ Error shutting down Kafka manager:', error);
      throw error;
    }
  }
}

// Singleton instance
let kafkaInstance: KafkaManager | null = null;

export function createKafkaManager(config: KafkaConfig): KafkaManager {
  if (!kafkaInstance) {
    kafkaInstance = new KafkaManager(config);
  }
  return kafkaInstance;
}

export function getKafkaManager(): KafkaManager {
  if (!kafkaInstance) {
    throw new Error('Kafka manager not initialized. Call createKafkaManager() first.');
  }
  return kafkaInstance;
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down Kafka manager...');
  if (kafkaInstance) {
    await kafkaInstance.close();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down Kafka manager...');
  if (kafkaInstance) {
    await kafkaInstance.close();
  }
  process.exit(0);
});

export { KafkaManager as Kafka };
