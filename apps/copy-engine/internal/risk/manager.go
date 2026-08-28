package risk

import "github.com/hyperdash/copy-engine/internal/config"

// Manager validates strategies against risk limits.
// Uses any for strategy to avoid import cycle with engine package.
type Manager struct {
	cfg config.RiskConfig
}

// NewManager creates a risk manager.
func NewManager(cfg config.RiskConfig) *Manager {
	return &Manager{cfg: cfg}
}

// ValidateStrategy validates a strategy against configured risk parameters.
// Accepts any to avoid circular dependency with engine package.
func (m *Manager) ValidateStrategy(s any) error {
	// Leverage check
	if m.cfg.MaxLeverage > 0 {
		if v, ok := s.(interface{ GetLeverage() float64 }); ok {
			if v.GetLeverage() > m.cfg.MaxLeverage {
				return ErrLeverageExceeded
			}
		}
	}
	// Position size check
	if m.cfg.MaxPositionSize > 0 {
		if v, ok := s.(interface{ GetPositionSize() float64 }); ok {
			if v.GetPositionSize() > m.cfg.MaxPositionSize {
				return ErrPositionSizeExceeded
			}
		}
	}
	return nil
}

var (
	ErrLeverageExceeded     = errLeverageExceeded("leverage exceeds max")
	ErrPositionSizeExceeded = errPositionSizeExceeded("position size exceeds max")
)

type errLeverageExceeded string
func (e errLeverageExceeded) Error() string { return string(e) }
type errPositionSizeExceeded string
func (e errPositionSizeExceeded) Error() string { return string(e) }
