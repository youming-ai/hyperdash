package exchange

import "github.com/hyperdash/copy-engine/internal/config"

// Adapter abstracts exchange interactions for the engine.
type Adapter interface {
  GetCurrentPositions(strategyID string) (map[string]float64, error)
  ExecuteBatch(strategyID string, deltas map[string]float64) error
}

type hyperliquidAdapter struct {
	cfg config.HyperliquidConfig
}

// NewHyperliquidAdapter returns a stub adapter satisfying Adapter.
func NewHyperliquidAdapter(cfg config.HyperliquidConfig) Adapter {
	return &hyperliquidAdapter{cfg: cfg}
}

func (a *hyperliquidAdapter) GetCurrentPositions(_ string) (map[string]float64, error) {
  return make(map[string]float64), nil
}

// ExecuteBatch executes deltas in one batch (stub, batches orders to reduce RPC).
func (a *hyperliquidAdapter) ExecuteBatch(_ string, deltas map[string]float64) error {
  if len(deltas) == 0 {
    return nil
  }
  // Real impl: build bulk order request, single HTTP call to Hyperliquid.
  return nil
}
