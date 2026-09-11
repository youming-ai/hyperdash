import http from 'node:http';
import { getLogger } from './utils/logger';

const logger = getLogger();

const healthCheck = async () => {
  const checks = {
    server: {
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
    database: await checkDatabase(),
    redis: await checkRedis(),
    kafka: await checkKafka(),
    external_apis: await checkExternalAPIs(),
  };

  // Overall health status
  const overallHealth = Object.values(checks).every((check) => check.status === 'healthy');

  const healthData = {
    status: overallHealth ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    checks,
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
  };

  logger.info('Health check completed', healthData);
  return healthData;
};

const checkDatabase = async () => {
  try {
    // Simple database ping would go here
    return {
      status: 'healthy',
      latency: Math.floor(Math.random() * 50) + 10, // Mock latency
      lastCheck: new Date().toISOString(),
    };
  } catch (error) {
    logger.error('Database health check failed:', error instanceof Error ? error : undefined);
    return {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
      lastCheck: new Date().toISOString(),
    };
  }
};

const checkRedis = async () => {
  try {
    // Simple Redis ping would go here
    return {
      status: 'healthy',
      latency: Math.floor(Math.random() * 20) + 5, // Mock latency
      lastCheck: new Date().toISOString(),
    };
  } catch (error) {
    logger.error('Redis health check failed:', error instanceof Error ? error : undefined);
    return {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
      lastCheck: new Date().toISOString(),
    };
  }
};

const checkKafka = async () => {
  try {
    // Simple Kafka connectivity check would go here
    return {
      status: 'healthy',
      connectedBrokers: 1,
      lastCheck: new Date().toISOString(),
    };
  } catch (error) {
    logger.error('Kafka health check failed:', error instanceof Error ? error : undefined);
    return {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
      lastCheck: new Date().toISOString(),
    };
  }
};

const checkExternalAPIs = async () => {
  try {
    // Check Hyperliquid API
    const hyperliquidCheck = await checkHyperliquidAPI();
    return {
      status: hyperliquidCheck.status,
      apis: {
        hyperliquid: hyperliquidCheck,
      },
      lastCheck: new Date().toISOString(),
    };
  } catch (error) {
    logger.error('External API health check failed:', error instanceof Error ? error : undefined);
    return {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
      lastCheck: new Date().toISOString(),
    };
  }
};

const checkHyperliquidAPI = async () => {
  try {
    // Mock API check - in production, this would make a real API call
    return {
      status: 'healthy',
      latency: Math.floor(Math.random() * 500) + 200, // Mock latency
      lastCheck: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
      lastCheck: new Date().toISOString(),
    };
  }
};

// Health check HTTP server
const server = http.createServer(async (_req, res) => {
  try {
    const healthData = await healthCheck();
    const isHealthy = healthData.status === 'healthy';

    res.writeHead(isHealthy ? 200 : 503, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    });

    res.end(JSON.stringify(healthData, null, 2));
  } catch (error) {
    logger.error('Health check server error:', error instanceof Error ? error : undefined);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'error',
        message: 'Health check failed',
        timestamp: new Date().toISOString(),
      }),
    );
  }
});

const PORT = process.env.HEALTH_CHECK_PORT || 3001;

server.listen(PORT, () => {
  logger.info(`Health check server listening on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('Health check server shutting down gracefully');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('Health check server shutting down gracefully');
  server.close(() => {
    process.exit(0);
  });
});

module.exports = healthCheck;
