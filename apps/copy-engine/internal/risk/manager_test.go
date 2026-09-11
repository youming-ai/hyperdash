package risk

import (
	"testing"

	"github.com/hyperdash/copy-engine/internal/config"
)

type mockStrategy struct {
	lev  float64
	size float64
}

func (m mockStrategy) GetLeverage() float64     { return m.lev }
func (m mockStrategy) GetPositionSize() float64 { return m.size }

func TestValidateStrategy(t *testing.T) {
	m := NewManager(config.RiskConfig{MaxLeverage: 5, MaxPositionSize: 10000})
	if err := m.ValidateStrategy(mockStrategy{lev: 3, size: 5000}); err != nil {
		t.Fatalf("expected pass, got %v", err)
	}
	if err := m.ValidateStrategy(mockStrategy{lev: 10, size: 5000}); err == nil {
		t.Fatal("expected leverage error")
	}
	if err := m.ValidateStrategy(mockStrategy{lev: 3, size: 20000}); err == nil {
		t.Fatal("expected size error")
	}
}

func BenchmarkValidateStrategy(b *testing.B) {
	m := NewManager(config.RiskConfig{MaxLeverage: 10, MaxPositionSize: 50000})
	s := mockStrategy{lev: 3, size: 1000}
	b.ResetTimer()
	for b.Loop() {
		_ = m.ValidateStrategy(s)
	}
}
