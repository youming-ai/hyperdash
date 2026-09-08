package queue

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

// CopySignal mirrors BE CopySignal
type CopySignal struct {
	StrategyID string `json:"strategyId"`
	UserID     string `json:"userId"`
	TraderID   string `json:"traderId"`
	Action     string `json:"action"`
	Timestamp  int64  `json:"timestamp"`
}

// Handler is called for each signal
type Handler func(ctx context.Context, sig CopySignal) error

// Consumer polls Redis for copy signals (BE -> Go)
type Consumer struct {
	rdb     *redis.Client
	handler Handler
}

func NewConsumer(redisURL string, handler Handler) *Consumer {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		log.Printf("queue: invalid REDIS_URL, using default: %v", err)
		opts = &redis.Options{Addr: "localhost:6379"}
	}
	return &Consumer{rdb: redis.NewClient(opts), handler: handler}
}

func (c *Consumer) Start(ctx context.Context) {
	go c.loop(ctx)
}

func (c *Consumer) loop(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.poll(ctx)
		}
	}
}

func (c *Consumer) poll(ctx context.Context) {
	res, err := c.rdb.XRead(ctx, &redis.XReadArgs{
		Streams: []string{"copy:signals", "0"},
		Count:   10,
		Block:   100 * time.Millisecond,
	}).Result()
	if err == nil && len(res) > 0 {
		for _, stream := range res {
			for _, msg := range stream.Messages {
				data, ok := msg.Values["data"].(string)
				if !ok {
					continue
				}
				var sig CopySignal
				if err := json.Unmarshal([]byte(data), &sig); err != nil {
					continue
				}
				if err := c.handler(ctx, sig); err != nil {
					log.Printf("queue: handler error: %v", err)
					continue
				}
				_ = c.rdb.XDel(ctx, "copy:signals", msg.ID).Err()
			}
		}
		return
	}
	val, err := c.rdb.BRPop(ctx, 1*time.Second, "copy:queue").Result()
	if err != nil || len(val) < 2 {
		return
	}
	var sig CopySignal
	if err := json.Unmarshal([]byte(val[1]), &sig); err != nil {
		return
	}
	_ = c.handler(ctx, sig)
}

func (c *Consumer) Stop() {
	_ = c.rdb.Close()
}
