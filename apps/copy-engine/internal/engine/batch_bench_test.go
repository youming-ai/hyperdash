package engine

import (
	"fmt"
	"testing"

	"github.com/hyperdash/copy-engine/internal/config"
	"github.com/hyperdash/copy-engine/internal/exchange"
	"github.com/hyperdash/copy-engine/internal/risk"
)

func BenchmarkCalculateDeltas100(b *testing.B) {
	cfg := &config.Config{Risk: config.RiskConfig{MinOrderSize: 0.001}}
	e := NewEngine(cfg, exchange.NewHyperliquidAdapter(cfg.Hyperliquid), risk.NewManager(cfg.Risk))
	current := make(map[string]float64, 100)
	target := make(map[string]float64, 100)
	for i := range 100 {
		sym := fmt.Sprintf("SYM%d", i)
		current[sym] = float64(i)
		target[sym] = float64(i) + 0.5
	}
	b.ResetTimer()
	for b.Loop() {
		_ = e.calculatePositionDeltas(current, target)
	}
}

func BenchmarkExecuteBatch100(b *testing.B) {
	cfg := &config.Config{Risk: config.RiskConfig{MinOrderSize: 0.001}}
	e := NewEngine(cfg, exchange.NewHyperliquidAdapter(cfg.Hyperliquid), risk.NewManager(cfg.Risk))
	strat := &Strategy{ID: "bench", RiskParams: RiskParameters{MaxLeverage: 10}}
	deltas := make(map[string]float64, 100)
	for i := range 100 {
		sym := fmt.Sprintf("SYM%d", i)
		deltas[sym] = float64(i) * 0.1
	}
	b.ResetTimer()
	for b.Loop() {
		_ = e.executePositionDeltas(strat, deltas)
	}
}
