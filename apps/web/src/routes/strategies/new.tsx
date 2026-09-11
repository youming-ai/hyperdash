import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '~/lib/api-client';

export const Route = createFileRoute('/strategies/new')({
  component: NewStrategyPage,
});

interface Allocation {
  traderId: string;
  weight: number;
}

interface RiskParams {
  maxLeverage: number;
  maxPositionUsd?: number;
  slippageBps: number;
  minOrderUsd: number;
}

interface Settings {
  followNewEntriesOnly: boolean;
  autoRebalance: boolean;
  rebalanceThresholdBps: number;
}

interface StrategyFormData {
  name: string;
  description: string;
  mode: 'portfolio' | 'single_trader';
  riskParams: RiskParams;
  settings: Settings;
  allocations: Allocation[];
}

interface TraderOption {
  address: string;
  traderId: string;
  pnl7d: number;
  winRate: number;
}

function NewStrategyPage() {
  const navigate = useNavigate();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showTraderSearch, setShowTraderSearch] = useState(false);

  const { data: topTradersData } = useQuery({
    queryKey: [
      'traders',
      { limit: '20', sortBy: 'pnl', sortOrder: 'desc', timeframe: '7d', isActive: 'true' },
    ],
    queryFn: async () => {
      const res = await api.traders.$get({
        query: {
          limit: '20',
          sortBy: 'pnl',
          sortOrder: 'desc',
          timeframe: '7d',
          isActive: 'true',
        },
      });
      if (!res.ok) throw new Error('failed to load traders');
      const body = (await res.json()) as unknown as {
        traders: Array<{
          address: string;
          traderId: string;
          pnl7d?: string | number | null;
          winrate?: string | number | null;
        }>;
      };
      return body;
    },
  });

  const topTraders: TraderOption[] =
    topTradersData?.traders.map((trader) => ({
      address: trader.address,
      traderId: trader.traderId,
      pnl7d: Number(trader.pnl7d ?? 0),
      winRate: Number(trader.winrate ?? 0),
    })) ?? [];

  const createStrategy = useMutation({
    mutationFn: async (input: StrategyFormData) => {
      const res = await api.strategies.$post({
        json: {
          name: input.name,
          description: input.description || undefined,
          mode: input.mode,
          riskParams: input.riskParams,
          settings: input.settings,
          allocations: input.allocations,
        },
      });
      if (!res.ok) throw new Error('failed to create strategy');
      return res.json();
    },
    onSuccess: () => navigate({ to: '/strategies' }),
  });

  const [formData, setFormData] = useState<StrategyFormData>({
    name: '',
    description: '',
    mode: 'portfolio',
    riskParams: {
      maxLeverage: 3,
      maxPositionUsd: undefined,
      slippageBps: 10,
      minOrderUsd: 100,
    },
    settings: {
      followNewEntriesOnly: true,
      autoRebalance: true,
      rebalanceThresholdBps: 50,
    },
    allocations: [],
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      // Validate allocations
      if (formData.allocations.length === 0) {
        alert('Please add at least one trader to copy.');
        return;
      }

      const totalWeight = formData.allocations.reduce((sum, a) => sum + a.weight, 0);
      if (Math.abs(totalWeight - 1.0) > 0.01) {
        alert(`Allocation weights must sum to 100%. Currently: ${Math.round(totalWeight * 100)}%`);
        return;
      }

      console.log('Creating strategy:', formData);
      await createStrategy.mutateAsync(formData);
    } catch (error) {
      console.error('Error creating strategy:', error);
      alert('Failed to create strategy. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const addAllocation = (traderId: string, weight: number = 0.5) => {
    if (formData.allocations.some((a) => a.traderId === traderId)) {
      alert('This trader is already in your allocations.');
      return;
    }

    // Auto-balance existing weights
    const currentTotal = formData.allocations.reduce((sum, a) => sum + a.weight, 0);
    let newAllocations = [...formData.allocations];

    if (currentTotal + weight > 1) {
      // Scale down existing allocations
      const scale = (1 - weight) / currentTotal;
      newAllocations = newAllocations.map((a) => ({
        ...a,
        weight: a.weight * scale,
      }));
    }

    newAllocations.push({ traderId, weight });
    setFormData({ ...formData, allocations: newAllocations });
    setShowTraderSearch(false);
  };

  const removeAllocation = (traderId: string) => {
    setFormData({
      ...formData,
      allocations: formData.allocations.filter((a) => a.traderId !== traderId),
    });
  };

  const updateAllocationWeight = (traderId: string, weight: number) => {
    const newAllocations = formData.allocations.map((a) =>
      a.traderId === traderId ? { ...a, weight } : a,
    );
    setFormData({ ...formData, allocations: newAllocations });
  };

  const totalAllocationWeight = formData.allocations.reduce((sum, a) => sum + a.weight, 0);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Create New Copy Strategy</h1>
        <p className="text-sm opacity-60 mt-1">
          Configure an automated copy trading strategy that follows top traders
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic Info */}
        <div className="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">Basic Information</h2>

          <div className="space-y-4">
            <div>
              <label htmlFor="strategy-name" className="block text-sm font-medium mb-2">
                Strategy Name
              </label>
              <input
                id="strategy-name"
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="w-full px-4 py-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]"
                placeholder="e.g., Conservative Growth Portfolio"
                required
              />
            </div>

            <div>
              <label htmlFor="strategy-description" className="block text-sm font-medium mb-2">
                Description (Optional)
              </label>
              <textarea
                id="strategy-description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="w-full px-4 py-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]"
                rows={2}
                placeholder="Briefly describe your strategy goals and approach..."
              />
            </div>

            <div>
              <label htmlFor="strategy-mode" className="block text-sm font-medium mb-2">
                Strategy Mode
              </label>
              <select
                id="strategy-mode"
                value={formData.mode}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    mode: e.target.value as 'portfolio' | 'single_trader',
                  })
                }
                className="w-full px-4 py-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]"
              >
                <option value="portfolio">Portfolio - Multiple traders with allocations</option>
                <option value="single_trader">Single Trader - Copy one trader exclusively</option>
              </select>
              <p className="text-xs opacity-60 mt-1">
                {formData.mode === 'portfolio'
                  ? 'Allocate your capital across multiple traders to diversify risk.'
                  : 'Follow a single trader with 100% allocation.'}
              </p>
            </div>
          </div>
        </div>

        {/* Trader Allocations */}
        <div className="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">
              Trader Allocations{' '}
              <span className="text-sm font-normal opacity-60">
                ({Math.round(totalAllocationWeight * 100)}% assigned)
              </span>
            </h2>
            <button
              type="button"
              onClick={() => setShowTraderSearch(!showTraderSearch)}
              className="px-3 py-1.5 text-sm rounded-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90 transition-opacity"
            >
              + Add Trader
            </button>
          </div>

          {showTraderSearch && (
            <div className="mb-4 p-4 rounded-lg bg-[hsl(var(--muted)/0.3)] border border-[hsl(var(--border))]">
              <h3 className="font-medium mb-3">Select Traders to Copy</h3>
              <div className="space-y-2">
                {topTraders.map((trader) => (
                  <div
                    key={trader.address}
                    className="flex items-center justify-between p-3 rounded-lg bg-[hsl(var(--card))] border border-[hsl(var(--border))]"
                  >
                    <div className="flex-1">
                      <p className="font-mono text-sm">{trader.address}</p>
                      <p className="text-xs opacity-60 font-mono">{trader.traderId}</p>
                    </div>
                    <div className="flex items-center gap-4 text-sm">
                      <div className="text-right">
                        <p className="text-success font-medium">
                          +${trader.pnl7d.toLocaleString()}
                        </p>
                        <p className="text-xs opacity-60">{trader.winRate}% win rate</p>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          addAllocation(
                            trader.traderId,
                            formData.mode === 'single_trader' ? 1.0 : 0.25,
                          )
                        }
                        className="px-3 py-1 text-sm rounded-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90 transition-opacity"
                      >
                        Add
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {formData.allocations.length > 0 ? (
            <div className="space-y-2">
              {formData.allocations.map((alloc) => (
                <div
                  key={alloc.traderId}
                  className="flex items-center gap-4 p-3 rounded-lg bg-[hsl(var(--muted)/0.3)] border border-[hsl(var(--border))]"
                >
                  <div className="flex-1">
                    <p className="font-medium text-sm font-mono">{alloc.traderId}</p>
                  </div>
                  {formData.mode === 'portfolio' && (
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="1"
                        max="100"
                        value={Math.round(alloc.weight * 100)}
                        onChange={(e) =>
                          updateAllocationWeight(alloc.traderId, Number(e.target.value) / 100)
                        }
                        className="w-24"
                      />
                      <input
                        type="number"
                        min="1"
                        max="100"
                        step="1"
                        value={Math.round(alloc.weight * 100)}
                        onChange={(e) =>
                          updateAllocationWeight(alloc.traderId, Number(e.target.value) / 100)
                        }
                        className="w-16 px-2 py-1 text-sm rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-center"
                      />
                      <span className="text-sm">%</span>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => removeAllocation(alloc.traderId)}
                    className="text-destructive hover:opacity-70 transition-opacity"
                  >
                    Remove
                  </button>
                </div>
              ))}
              {totalAllocationWeight !== 1 && (
                <p className="text-xs opacity-60">
                  Total allocation: {Math.round(totalAllocationWeight * 100)}%.{' '}
                  {totalAllocationWeight < 1
                    ? `${Math.round((1 - totalAllocationWeight) * 100)}% remaining.`
                    : 'Over-allocated. Please adjust weights.'}
                </p>
              )}
            </div>
          ) : (
            <p className="text-center py-8 opacity-60">
              No traders added yet. Click "Add Trader" to select traders to copy.
            </p>
          )}
        </div>

        {/* Risk Parameters */}
        <div className="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">Risk Parameters</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="max-leverage" className="block text-sm font-medium mb-2">
                Max Leverage
              </label>
              <input
                id="max-leverage"
                type="number"
                min="1"
                max="10"
                step="0.5"
                value={formData.riskParams.maxLeverage}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    riskParams: {
                      ...formData.riskParams,
                      maxLeverage: Number(e.target.value),
                    },
                  })
                }
                className="w-full px-4 py-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]"
              />
              <p className="text-xs opacity-60 mt-1">Maximum position leverage multiplier</p>
            </div>

            <div>
              <label htmlFor="max-position-usd" className="block text-sm font-medium mb-2">
                Max Position Size (USD)
              </label>
              <input
                id="max-position-usd"
                type="number"
                min="100"
                step="100"
                value={formData.riskParams.maxPositionUsd ?? ''}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    riskParams: {
                      ...formData.riskParams,
                      maxPositionUsd: e.target.value ? Number(e.target.value) : undefined,
                    },
                  })
                }
                className="w-full px-4 py-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]"
                placeholder="No limit"
              />
              <p className="text-xs opacity-60 mt-1">Optional: Maximum size per position</p>
            </div>

            <div>
              <label htmlFor="slippage-bps" className="block text-sm font-medium mb-2">
                Slippage Tolerance (bps)
              </label>
              <input
                id="slippage-bps"
                type="number"
                min="0"
                max="100"
                value={formData.riskParams.slippageBps}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    riskParams: {
                      ...formData.riskParams,
                      slippageBps: Number(e.target.value),
                    },
                  })
                }
                className="w-full px-4 py-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]"
              />
              <p className="text-xs opacity-60 mt-1">
                {formData.riskParams.slippageBps / 100}% max acceptable slippage
              </p>
            </div>

            <div>
              <label htmlFor="min-order-usd" className="block text-sm font-medium mb-2">
                Min Order Size (USD)
              </label>
              <input
                id="min-order-usd"
                type="number"
                min="5"
                step="5"
                value={formData.riskParams.minOrderUsd}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    riskParams: {
                      ...formData.riskParams,
                      minOrderUsd: Number(e.target.value),
                    },
                  })
                }
                className="w-full px-4 py-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]"
              />
              <p className="text-xs opacity-60 mt-1">Minimum order size to execute</p>
            </div>
          </div>
        </div>

        {/* Copy Settings */}
        <div className="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">Copy Settings</h2>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Follow New Entries Only</p>
                <p className="text-sm opacity-60">
                  Only copy new trades, don't sync existing positions
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.settings.followNewEntriesOnly}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      settings: {
                        ...formData.settings,
                        followNewEntriesOnly: e.target.checked,
                      },
                    })
                  }
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-[hsl(var(--border))] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[hsl(var(--primary))]" />
              </label>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Auto Rebalance</p>
                <p className="text-sm opacity-60">
                  Automatically rebalance when positions drift from target allocation
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.settings.autoRebalance}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      settings: {
                        ...formData.settings,
                        autoRebalance: e.target.checked,
                      },
                    })
                  }
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-[hsl(var(--border))] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[hsl(var(--primary))]" />
              </label>
            </div>

            <div>
              <label htmlFor="rebalance-threshold-bps" className="block text-sm font-medium mb-2">
                Rebalance Threshold (bps)
              </label>
              <input
                id="rebalance-threshold-bps"
                type="number"
                min="0"
                max="500"
                step="5"
                value={formData.settings.rebalanceThresholdBps}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    settings: {
                      ...formData.settings,
                      rebalanceThresholdBps: Number(e.target.value),
                    },
                  })
                }
                disabled={!formData.settings.autoRebalance}
                className="w-full px-4 py-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))] disabled:opacity-50"
              />
              <p className="text-xs opacity-60 mt-1">
                Trigger rebalance when allocation drifts by{' '}
                {formData.settings.rebalanceThresholdBps / 100}%
              </p>
            </div>
          </div>
        </div>

        {/* Submit */}
        <div className="flex gap-4">
          <button
            type="button"
            onClick={() => navigate({ to: '/strategies' })}
            className="flex-1 px-4 py-3 rounded-lg border border-[hsl(var(--border))] font-medium hover:bg-[hsl(var(--accent))] transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting || formData.allocations.length === 0}
            className="flex-1 px-4 py-3 rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? 'Creating...' : 'Create Strategy'}
          </button>
        </div>
      </form>
    </div>
  );
}
