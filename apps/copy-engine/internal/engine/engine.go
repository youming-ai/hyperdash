package engine

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/hyperdash/copy-engine/internal/config"
	"github.com/hyperdash/copy-engine/internal/exchange"
	"github.com/hyperdash/copy-engine/internal/risk"
)

type Engine struct {
	config          *config.Config
	exchangeAdapter exchange.Adapter
	riskManager     *risk.Manager

	// State management
	strategies       map[string]*Strategy
	strategiesMutex  sync.RWMutex
	activeStrategies  map[string]bool

	// Channels
	commandChan     chan Command
	stopChan         chan struct{}
	wg               sync.WaitGroup

	// Metrics
	metrics          *Metrics
}

type Strategy struct {
	ID              string
	UserID          string
	Name            string
	Traders         []TraderAllocation
	RiskParams      RiskParameters
	Status          StrategyStatus
	Positions       map[string]*Position
	LastExecution   time.Time
	AlignmentRate   float64
	mutex           sync.RWMutex
}

type TraderAllocation struct {
	TraderID string
	Weight   float64
}

type RiskParameters struct {
	MaxLeverage     float64
	MaxSlippage     float64
	MinOrderSize    float64
	FollowNewEntries bool
}

type Position struct {
	Symbol        string
	Quantity      float64
	EntryPrice    float64
	CurrentPrice  float64
	UnrealizedPnL float64
	Leverage      float64
}

type StrategyStatus string

const (
	StatusActive   StrategyStatus = "active"
	StatusPaused   StrategyStatus = "paused"
	StatusError    StrategyStatus = "error"
	StatusTerminated StrategyStatus = "terminated"
)

type Command struct {
	Type      CommandType
	StrategyID string
	Data      interface{}
}

type CommandType string

const (
	CommandStartStrategy   CommandType = "start_strategy"
	CommandStopStrategy    CommandType = "stop_strategy"
	CommandUpdateStrategy  CommandType = "update_strategy"
	CommandPositionUpdate  CommandType = "position_update"
)

type Metrics struct {
	TotalStrategies      int
	ActiveStrategies     int
	TotalPositions       int
	SuccessfulExecutions int
	FailedExecutions     int
	AverageLatency       time.Duration
	AlignmentRate        float64
	mutex                 sync.RWMutex
}

func NewEngine(cfg *config.Config, exchangeAdapter exchange.Adapter, riskManager *risk.Manager) *Engine {
	return &Engine{
		config:          cfg,
		exchangeAdapter: exchangeAdapter,
		riskManager:     riskManager,
		strategies:      make(map[string]*Strategy),
		activeStrategies: make(map[string]bool),
		commandChan:     make(chan Command, 100),
		stopChan:        make(chan struct{}),
		metrics:         &Metrics{},
	}
}

func (e *Engine) Start(ctx context.Context) error {
	log.Printf("Starting Copy Trading Engine with max concurrency: %d", e.config.Engine.MaxConcurrency)

	e.wg.Add(1)
	go e.commandProcessor()

	e.wg.Add(1)
	go e.positionMonitor(ctx)

	log.Println("Copy Trading Engine started successfully")
	return nil
}

func (e *Engine) Stop(ctx context.Context) error {
	log.Println("Stopping Copy Trading Engine...")

	close(e.stopChan)
	close(e.commandChan)

	// Stop all active strategies
	e.strategiesMutex.Lock()
	for id := range e.strategies {
		e.stopStrategy(id)
	}
	e.strategiesMutex.Unlock()

	// Wait for all goroutines to finish
	done := make(chan struct{})
	go func() {
		e.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		log.Println("Copy Trading Engine stopped successfully")
		return nil
	case <-time.After(30 * time.Second):
		log.Println("Warning: Copy Trading Engine shutdown timeout")
		return ctx.Err()
	}
}

func (e *Engine) StartStrategy(strategy *Strategy) error {
	e.strategiesMutex.Lock()
	defer e.strategiesMutex.Unlock()

	if _, exists := e.strategies[strategy.ID]; exists {
		return fmt.Errorf("strategy %s already exists", strategy.ID)
	}

	e.strategies[strategy.ID] = strategy
	e.activeStrategies[strategy.ID] = true

	// Send start command
	e.commandChan <- Command{
		Type:      CommandStartStrategy,
		StrategyID: strategy.ID,
		Data:      strategy,
	}

	log.Printf("Strategy %s started", strategy.ID)
	return nil
}

func (e *Engine) StopStrategy(strategyID string) error {
	e.strategiesMutex.Lock()
	defer e.strategiesMutex.Unlock()

	strategy, exists := e.strategies[strategyID]
	if !exists {
		return fmt.Errorf("strategy %s not found", strategyID)
	}

	e.activeStrategies[strategyID] = false
	strategy.Status = StatusPaused

	e.commandChan <- Command{
		Type:      CommandStopStrategy,
		StrategyID: strategyID,
	}

	log.Printf("Strategy %s stopped", strategyID)
	return nil
}

func (e *Engine) stopStrategy(strategyID string) {
	e.activeStrategies[strategyID] = false
	if strategy, exists := e.strategies[strategyID]; exists {
		strategy.Status = StatusTerminated
	}
}

func (e *Engine) commandProcessor() {
	defer e.wg.Done()

	for {
		select {
		case command := <-e.commandChan:
			e.processCommand(command)
		case <-e.stopChan:
			return
		}
	}
}

func (e *Engine) processCommand(command Command) {
	switch command.Type {
	case CommandStartStrategy:
		e.handleStartStrategy(command)
	case CommandStopStrategy:
		e.handleStopStrategy(command)
	case CommandUpdateStrategy:
		e.handleUpdateStrategy(command)
	case CommandPositionUpdate:
		e.handlePositionUpdate(command)
	}
}

func (e *Engine) handleStartStrategy(command Command) {
	strategy := command.Data.(*Strategy)

	// Validate strategy with risk manager
	if err := e.riskManager.ValidateStrategy(strategy); err != nil {
		log.Printf("Risk validation failed for strategy %s: %v", strategy.ID, err)
		strategy.Status = StatusError
		return
	}

	strategy.Status = StatusActive
	log.Printf("Strategy %s processing started", strategy.ID)
}

func (e *Engine) handleStopStrategy(command Command) {
	// Handle strategy stop logic
	log.Printf("Strategy %s processing stopped", command.StrategyID)
}

func (e *Engine) handleUpdateStrategy(command Command) {
	// Handle strategy update logic
	log.Printf("Strategy %s updated", command.StrategyID)
}

func (e *Engine) handlePositionUpdate(command Command) {
	// Handle position update logic
	log.Printf("Position update for strategy %s", command.StrategyID)
}

func (e *Engine) positionMonitor(ctx context.Context) {
	defer e.wg.Done()

	ticker := time.NewTicker(time.Duration(e.config.Engine.ExecutionInterval) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			e.checkAndUpdatePositions()
		case <-ctx.Done():
			return
		case <-e.stopChan:
			return
		}
	}
}

func (e *Engine) checkAndUpdatePositions() {
	e.strategiesMutex.RLock()

	for strategyID, strategy := range e.strategies {
		if !e.activeStrategies[strategyID] {
			continue
		}

		e.processStrategy(strategy)
	}

	e.strategiesMutex.RUnlock()
}

func (e *Engine) processStrategy(strategy *Strategy) {
	start := time.Now()

	// Get current positions from exchange
	positions, err := e.exchangeAdapter.GetCurrentPositions(strategy.ID)
	if err != nil {
		log.Printf("Failed to get positions for strategy %s: %v", strategy.ID, err)
		e.metrics.FailedExecutions++
		return
	}

	// Calculate target positions based on trader allocations
	targetPositions := e.calculateTargetPositions(strategy)

	// Calculate position deltas
	deltas := e.calculatePositionDeltas(positions, targetPositions)

	// Execute trades if needed
	if len(deltas) > 0 {
		if err := e.executePositionDeltas(strategy, deltas); err != nil {
			log.Printf("Failed to execute position deltas for strategy %s: %v", strategy.ID, err)
			e.metrics.FailedExecutions++
		} else {
			e.metrics.SuccessfulExecutions++
		}
	}

	// Update alignment rate
	strategy.AlignmentRate = e.calculateAlignmentRate(positions, targetPositions)

	// Update metrics
	latency := time.Since(start)
	e.updateMetrics(latency)

	strategy.LastExecution = time.Now()
}

func (e *Engine) calculateTargetPositions(strategy *Strategy) map[string]float64 {
	// TODO: Implement target position calculation based on trader allocations
	return make(map[string]float64)
}

func (e *Engine) calculatePositionDeltas(current, target map[string]float64) map[string]float64 {
	deltas := make(map[string]float64)

	for symbol, targetQty := range target {
		currentQty := current[symbol]
		delta := targetQty - currentQty

		// Apply minimum order size filter
		if abs(delta) >= e.config.Risk.MinOrderSize {
			deltas[symbol] = delta
		}
	}

	return deltas
}

func (e *Engine) executePositionDeltas(strategy *Strategy, deltas map[string]float64) error {
  if len(deltas) == 0 {
    return nil
  }
  if err := e.riskManager.ValidateStrategy(strategy); err != nil {
    return err
  }
  return e.exchangeAdapter.ExecuteBatch(strategy.ID, deltas)
}

func (e *Engine) calculateAlignmentRate(current, target map[string]float64) float64 {
	if len(target) == 0 {
		return 100.0
	}

	var totalDifference float64
	for symbol, targetQty := range target {
		currentQty := current[symbol]
		if targetQty != 0 {
			difference := abs(targetQty-currentQty) / abs(targetQty)
			totalDifference += difference
		}
	}

	alignment := (1 - totalDifference/float64(len(target))) * 100
	return max(0, min(100, alignment))
}

func (e *Engine) updateMetrics(latency time.Duration) {
	e.metrics.mutex.Lock()
	defer e.metrics.mutex.Unlock()

	// Update average latency
	if e.metrics.AverageLatency == 0 {
		e.metrics.AverageLatency = latency
	} else {
		e.metrics.AverageLatency = (e.metrics.AverageLatency + latency) / 2
	}

	// Update counts
	e.metrics.TotalStrategies = len(e.strategies)
	e.metrics.ActiveStrategies = len(e.activeStrategies)

	// Calculate overall alignment rate
	var totalAlignment float64
	var activeCount int

	for _, strategy := range e.strategies {
		if e.activeStrategies[strategy.ID] {
			totalAlignment += strategy.AlignmentRate
			activeCount++
		}
	}

	if activeCount > 0 {
		e.metrics.AlignmentRate = totalAlignment / float64(activeCount)
	}
}

func (e *Engine) GetMetrics() Metrics {
	e.metrics.mutex.RLock()
	defer e.metrics.mutex.RUnlock()
	return Metrics{
		TotalStrategies:      e.metrics.TotalStrategies,
		ActiveStrategies:     e.metrics.ActiveStrategies,
		TotalPositions:       e.metrics.TotalPositions,
		SuccessfulExecutions: e.metrics.SuccessfulExecutions,
		FailedExecutions:     e.metrics.FailedExecutions,
		AverageLatency:       e.metrics.AverageLatency,
		AlignmentRate:        e.metrics.AlignmentRate,
	}
}

func (e *Engine) GetStrategy(strategyID string) (*Strategy, error) {
	e.strategiesMutex.RLock()
	defer e.strategiesMutex.RUnlock()

	strategy, exists := e.strategies[strategyID]
	if !exists {
		return nil, fmt.Errorf("strategy %s not found", strategyID)
	}

	return strategy, nil
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

func max(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func min(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
