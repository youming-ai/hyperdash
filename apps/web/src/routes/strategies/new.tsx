import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Button, buttonVariants } from '~/components/ui/button';
import { PageHeader } from '~/components/ui/page-header';
import { Panel, PanelBody, PanelHeader } from '~/components/ui/panel';
import { ErrorNotice, SkeletonRows } from '~/components/ui/state';
import { ApiError, api, readJson } from '~/lib/api-client';
import { cn, formatPercent, formatPnL, shortenAddress, toNumber } from '~/lib/utils';

export const Route = createFileRoute('/strategies/new')({
  /**
   * The traders surface links here with `?trader=<address>`; the address is
   * resolved and pre-added to the allocation editor below.
   */
  validateSearch: (search: Record<string, unknown>): { trader?: string } => ({
    trader:
      typeof search.trader === 'string' && search.trader.length > 0 ? search.trader : undefined,
  }),
  component: NewStrategyPage,
});

/** Weights are edited as whole percents so "must total 100" is an integer sum. */
const TOTAL_PCT = 100;
/** A 0% allocation is not a real allocation — the API rejects weights of 0. */
const MIN_WEIGHT_PCT = 1;
/** Matches the server's `/traders` cap and the picker's ranking caption. */
const TRADER_LIMIT = 20;
const TRADER_FRESH_MS = 5 * 60 * 1000;

type StrategyMode = 'portfolio' | 'single_trader';

interface TraderOption {
  traderId: string;
  address: string;
  pnl7d: number;
  winRate: number;
}

/** Raw row shape of `/traders` — DB numerics arrive as strings. */
interface TraderRow {
  traderId: string;
  address: string;
  pnl7d?: string | number | null;
  winrate?: string | number | null;
}

/** An allocation as the user edits it: identity plus an integer percent. */
interface Allocation {
  traderId: string;
  address: string;
  weightPct: number;
}

type AllocationIdentity = Pick<Allocation, 'traderId' | 'address'>;

interface RiskParams {
  maxLeverage: number;
  maxPositionUsd: number | null;
  slippageBps: number;
  minOrderUsd: number;
}

interface Settings {
  followNewEntriesOnly: boolean;
  autoRebalance: boolean;
  rebalanceThresholdBps: number;
}

interface FormState {
  name: string;
  description: string;
  mode: StrategyMode;
  riskParams: RiskParams;
  settings: Settings;
  allocations: Allocation[];
}

interface FormErrors {
  name?: string;
  allocations?: string;
  maxLeverage?: string;
  maxPositionUsd?: string;
  slippageBps?: string;
  minOrderUsd?: string;
  rebalanceThresholdBps?: string;
}

type FormAction =
  | { type: 'basic'; patch: Partial<Pick<FormState, 'name' | 'description'>> }
  | { type: 'mode'; mode: StrategyMode }
  | { type: 'risk'; patch: Partial<RiskParams> }
  | { type: 'setting'; patch: Partial<Settings> }
  | { type: 'addTrader'; trader: TraderOption }
  | { type: 'removeTrader'; traderId: string }
  | { type: 'weight'; traderId: string; weightPct: number };

const INITIAL_STATE: FormState = {
  name: '',
  description: '',
  mode: 'portfolio',
  riskParams: { maxLeverage: 3, maxPositionUsd: null, slippageBps: 10, minOrderUsd: 100 },
  settings: { followNewEntriesOnly: true, autoRebalance: true, rebalanceThresholdBps: 50 },
  allocations: [],
};

/**
 * Split 100% across `count` allocations in whole percents, handing the
 * remainder to the earliest rows so the total is always exactly 100.
 */
function evenWeights(count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(TOTAL_PCT / count);
  const remainder = TOTAL_PCT - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function withEvenWeights(identities: AllocationIdentity[]): Allocation[] {
  const weights = evenWeights(identities.length);
  return identities.map((identity, index) => ({ ...identity, weightPct: weights[index] }));
}

/**
 * Every weight edit goes through here, so no path can produce a 0% allocation
 * (the API rejects weight 0) or a value outside 1–100%.
 */
function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'basic':
      return { ...state, ...action.patch };

    case 'mode': {
      if (action.mode === state.mode) return state;
      if (action.mode === 'single_trader') {
        // single_trader means exactly one trader at 100%. Keep the first and
        // drop the rest rather than carrying an invalid combination forward for
        // a submit-time check to catch.
        const [first] = state.allocations;
        return {
          ...state,
          mode: action.mode,
          allocations: first ? [{ ...first, weightPct: TOTAL_PCT }] : [],
        };
      }
      // portfolio: an even split is the only sane starting point when the
      // previous mode had pinned every weight.
      return {
        ...state,
        mode: action.mode,
        allocations: withEvenWeights(
          state.allocations.map(({ traderId, address }) => ({ traderId, address })),
        ),
      };
    }

    case 'risk':
      return { ...state, riskParams: { ...state.riskParams, ...action.patch } };

    case 'setting':
      return { ...state, settings: { ...state.settings, ...action.patch } };

    case 'addTrader': {
      if (state.allocations.some((a) => a.traderId === action.trader.traderId)) return state;
      const added: AllocationIdentity = {
        traderId: action.trader.traderId,
        address: action.trader.address,
      };
      if (state.mode === 'single_trader') {
        // Replace, never scale the previous trader down to 0%.
        return { ...state, allocations: [{ ...added, weightPct: TOTAL_PCT }] };
      }
      return {
        ...state,
        allocations: withEvenWeights([
          ...state.allocations.map(({ traderId, address }) => ({ traderId, address })),
          added,
        ]),
      };
    }

    case 'removeTrader':
      return {
        ...state,
        allocations: state.allocations.filter((a) => a.traderId !== action.traderId),
      };

    case 'weight': {
      const weightPct = Math.max(MIN_WEIGHT_PCT, Math.min(TOTAL_PCT, Math.round(action.weightPct)));
      return {
        ...state,
        allocations: state.allocations.map((a) =>
          a.traderId === action.traderId ? { ...a, weightPct } : a,
        ),
      };
    }
  }
}

/** Integer-percent validation — no float comparison is involved. */
function validate(state: FormState): FormErrors {
  const errors: FormErrors = {};

  const name = state.name.trim();
  if (!name) errors.name = 'Enter a name for this strategy.';
  else if (name.length > 100) errors.name = 'Keep the name to 100 characters or fewer.';

  const { allocations, mode } = state;
  const totalPct = allocations.reduce((sum, allocation) => sum + allocation.weightPct, 0);

  if (allocations.length === 0) {
    errors.allocations = 'Add at least one trader to copy.';
  } else if (
    mode === 'single_trader' &&
    (allocations.length !== 1 || allocations[0].weightPct !== TOTAL_PCT)
  ) {
    errors.allocations = 'Single Trader mode copies exactly one trader at 100%.';
  } else if (allocations.some((allocation) => allocation.weightPct < MIN_WEIGHT_PCT)) {
    errors.allocations = `Every allocation needs at least ${MIN_WEIGHT_PCT}%.`;
  } else if (totalPct !== TOTAL_PCT) {
    errors.allocations = `Allocation weights must total 100% — currently ${totalPct}%.`;
  }

  const { maxLeverage, maxPositionUsd, slippageBps, minOrderUsd } = state.riskParams;
  if (!Number.isFinite(maxLeverage) || maxLeverage < 1 || maxLeverage > 10) {
    errors.maxLeverage = 'Max leverage must be between 1x and 10x.';
  }
  if (maxPositionUsd !== null && (!Number.isFinite(maxPositionUsd) || maxPositionUsd <= 0)) {
    errors.maxPositionUsd = 'Max position size must be above $0, or left empty for no limit.';
  }
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 100) {
    errors.slippageBps = 'Slippage tolerance must be between 0 and 100 bps.';
  }
  if (!Number.isFinite(minOrderUsd) || minOrderUsd <= 0) {
    errors.minOrderUsd = 'Minimum order size must be above $0.';
  }

  const threshold = state.settings.rebalanceThresholdBps;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 500) {
    errors.rebalanceThresholdBps = 'Rebalance threshold must be between 0 and 500 bps.';
  }

  return errors;
}

/** The single most important reason the form cannot be submitted yet. */
function blockingReason(errors: FormErrors): string | null {
  if (errors.allocations) return errors.allocations;
  if (errors.name) return errors.name;
  if (errors.maxLeverage) return errors.maxLeverage;
  if (errors.maxPositionUsd) return errors.maxPositionUsd;
  if (errors.slippageBps) return errors.slippageBps;
  if (errors.minOrderUsd) return errors.minOrderUsd;
  if (errors.rebalanceThresholdBps) return errors.rebalanceThresholdBps;
  return null;
}

interface TraderDirectory {
  traders: TraderOption[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  retry: () => void;
}

function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-destructive">
      {message}
    </p>
  );
}

/**
 * One labelled switch. The whole row is the <label>, so the visible text is a
 * hit target and the control is named; focus is shown on the visual track
 * because the checkbox itself is visually hidden.
 */
function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start justify-between gap-4">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-fg-tertiary">{description}</span>
      </span>
      <span className="relative mt-0.5 inline-flex shrink-0 items-center">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className="block h-5 w-9 rounded-full bg-inset ring-1 ring-[var(--input)] transition-colors peer-checked:bg-primary peer-checked:ring-primary peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--ring)] peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-0.5 left-0.5 size-4 rounded-full bg-foreground transition-transform peer-checked:translate-x-4 peer-checked:bg-primary-foreground"
        />
      </span>
    </label>
  );
}

/** The one numeric field shape: `.field`, a help line and an inline error. */
function NumberField({
  id,
  label,
  help,
  value,
  error,
  showError,
  onChange,
  min,
  max,
  step,
  placeholder,
  disabled = false,
}: {
  id: string;
  label: string;
  help: ReactNode;
  value: number | string;
  error?: string;
  showError: boolean;
  onChange: (raw: string) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  disabled?: boolean;
}) {
  const invalid = showError && Boolean(error);
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type="number"
        className="field"
        value={value}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={cn(`${id}-help`, invalid ? `${id}-error` : null)}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={`${id}-help`} className="mt-1 text-xs text-fg-tertiary">
        {help}
      </p>
      {invalid && error ? <FieldError id={`${id}-error`} message={error} /> : null}
    </div>
  );
}

function StrategyBasics({
  name,
  description,
  mode,
  error,
  showError,
  onBasic,
  onMode,
}: {
  name: string;
  description: string;
  mode: StrategyMode;
  error?: string;
  showError: boolean;
  onBasic: (patch: Partial<Pick<FormState, 'name' | 'description'>>) => void;
  onMode: (mode: StrategyMode) => void;
}) {
  const invalid = showError && Boolean(error);
  return (
    <Panel>
      <PanelHeader title="Basic information" />
      <PanelBody className="space-y-3">
        <div>
          <label htmlFor="strategy-name" className="mb-1 block text-sm font-medium">
            Strategy name
          </label>
          <input
            id="strategy-name"
            type="text"
            className="field"
            value={name}
            maxLength={100}
            placeholder="e.g. Conservative Growth Portfolio"
            aria-invalid={invalid}
            aria-describedby={invalid ? 'strategy-name-error' : undefined}
            onChange={(event) => onBasic({ name: event.target.value })}
          />
          {invalid && error ? <FieldError id="strategy-name-error" message={error} /> : null}
        </div>

        <div>
          <label htmlFor="strategy-description" className="mb-1 block text-sm font-medium">
            Description <span className="text-fg-tertiary">(optional)</span>
          </label>
          <textarea
            id="strategy-description"
            className="field"
            rows={2}
            maxLength={500}
            value={description}
            placeholder="Briefly describe your strategy goals and approach…"
            onChange={(event) => onBasic({ description: event.target.value })}
          />
        </div>

        <div>
          <label htmlFor="strategy-mode" className="mb-1 block text-sm font-medium">
            Strategy mode
          </label>
          <select
            id="strategy-mode"
            className="field"
            value={mode}
            onChange={(event) =>
              onMode(event.target.value === 'single_trader' ? 'single_trader' : 'portfolio')
            }
          >
            <option value="portfolio">Portfolio — multiple traders with allocations</option>
            <option value="single_trader">Single Trader — copy one trader exclusively</option>
          </select>
          <p className="mt-1 text-xs text-fg-tertiary">
            {mode === 'portfolio'
              ? 'Allocate your capital across multiple traders to diversify risk.'
              : 'Follow a single trader with 100% of the strategy allocation.'}
          </p>
        </div>
      </PanelBody>
    </Panel>
  );
}

/**
 * Ranked trader picker. Each request state is distinct: skeleton rows while
 * loading, a retryable error line, an explicit empty state, and a per-row
 * "Added" state instead of a duplicate action.
 */
function TraderPicker({
  directory,
  addedIds,
  onAdd,
}: {
  directory: TraderDirectory;
  addedIds: ReadonlySet<string>;
  onAdd: (trader: TraderOption) => void;
}) {
  return (
    <div className="mb-3 rounded-md border border-border bg-inset p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium">Select traders to copy</h3>
        <p className="text-2xs text-fg-tertiary">
          Top {TRADER_LIMIT} by 7d PnL, active in the last 7 days
        </p>
      </div>

      {directory.isPending ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading top traders</span>
          <SkeletonRows rows={4} />
        </div>
      ) : directory.isError ? (
        <ErrorNotice
          message={
            directory.error instanceof Error
              ? directory.error.message
              : 'Could not load the top traders.'
          }
          onRetry={directory.retry}
        />
      ) : directory.traders.length === 0 ? (
        <p className="px-1 py-6 text-center text-xs text-fg-tertiary">
          No active traders to show right now. Try again in a few minutes.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {directory.traders.map((trader, index) => {
            const added = addedIds.has(trader.traderId);
            return (
              <li
                key={trader.traderId}
                className="flex items-center justify-between gap-3 rounded-md bg-raised/60 p-2.5"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="num w-5 shrink-0 text-2xs text-fg-quaternary">{index + 1}</span>
                  <div className="min-w-0">
                    <Link
                      to="/traders/$address"
                      params={{ address: trader.address }}
                      title={trader.address}
                      className="num block min-w-0 truncate text-sm transition-colors hover:text-fg-accent"
                    >
                      {shortenAddress(trader.address)}
                    </Link>
                    <p className="num text-2xs">
                      <span className={trader.pnl7d >= 0 ? 'text-up' : 'text-down'}>
                        {formatPnL(trader.pnl7d, { compact: true })}
                      </span>
                      <span className="text-fg-tertiary">
                        {' '}
                        7d · {formatPercent(trader.winRate, 0)} win rate
                      </span>
                    </p>
                  </div>
                </div>
                <Button
                  variant={added ? 'subtle' : 'primary'}
                  size="sm"
                  disabled={added}
                  aria-label={
                    added
                      ? `${shortenAddress(trader.address)} is already allocated`
                      : `Add ${shortenAddress(trader.address)}`
                  }
                  onClick={() => onAdd(trader)}
                >
                  {added ? 'Added' : 'Add'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AllocationEditor({
  mode,
  allocations,
  totalPct,
  error,
  showError,
  pickerOpen,
  onTogglePicker,
  directory,
  onAdd,
  onRemove,
  onWeight,
  requested,
}: {
  mode: StrategyMode;
  allocations: Allocation[];
  totalPct: number;
  error?: string;
  showError: boolean;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  directory: TraderDirectory;
  onAdd: (trader: TraderOption) => void;
  onRemove: (traderId: string) => void;
  onWeight: (traderId: string, weightPct: number) => void;
  requested: { address: string; isPending: boolean; isError: boolean; retry: () => void } | null;
}) {
  const addedIds = useMemo(
    () => new Set(allocations.map((allocation) => allocation.traderId)),
    [allocations],
  );

  return (
    <Panel>
      <PanelHeader
        title="Trader allocations"
        actions={
          <Button
            variant={pickerOpen ? 'subtle' : 'primary'}
            size="sm"
            aria-expanded={pickerOpen}
            aria-controls="trader-picker"
            onClick={onTogglePicker}
          >
            {pickerOpen ? 'Close picker' : 'Add trader'}
          </Button>
        }
      />
      <PanelBody className="space-y-3">
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-fg-tertiary">Capital assigned</span>
            <span className="num text-sm font-medium">{totalPct}%</span>
          </div>
          <div
            role="progressbar"
            aria-label="Total allocation assigned"
            aria-valuenow={totalPct}
            aria-valuemin={0}
            aria-valuemax={TOTAL_PCT}
            className="mt-1 h-1.5 overflow-hidden rounded-full bg-inset"
          >
            <div
              className={cn(
                'h-full rounded-full transition-[width]',
                totalPct === TOTAL_PCT
                  ? 'bg-success'
                  : totalPct > TOTAL_PCT
                    ? 'bg-destructive'
                    : 'bg-primary',
              )}
              style={{ width: `${Math.min(totalPct, TOTAL_PCT)}%` }}
            />
          </div>
          <p
            role="status"
            className={cn(
              'mt-1.5 text-xs',
              totalPct === TOTAL_PCT
                ? 'text-success'
                : totalPct > TOTAL_PCT
                  ? 'text-destructive'
                  : 'text-fg-tertiary',
            )}
          >
            {totalPct === TOTAL_PCT
              ? 'All capital is assigned.'
              : totalPct > TOTAL_PCT
                ? `Over-allocated by ${totalPct - TOTAL_PCT}% — lower a weight to continue.`
                : `${TOTAL_PCT - totalPct}% still unassigned.`}
          </p>
        </div>

        {requested ? (
          requested.isPending ? (
            <p className="text-xs text-fg-tertiary" role="status">
              Adding {shortenAddress(requested.address)} from the traders page…
            </p>
          ) : requested.isError ? (
            <ErrorNotice
              message={`Could not load trader ${requested.address} from the link you followed. Pick a trader below instead.`}
              onRetry={requested.retry}
            />
          ) : null
        ) : null}

        {pickerOpen ? (
          <div id="trader-picker">
            <TraderPicker directory={directory} addedIds={addedIds} onAdd={onAdd} />
          </div>
        ) : null}

        {allocations.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-fg-tertiary">
            No traders added yet. Use “Add trader” to pick from the top performers.
          </p>
        ) : (
          <ul className="space-y-2">
            {allocations.map((allocation) => {
              const label = shortenAddress(allocation.address);
              const errorId = showError && error ? ' allocations-error' : '';
              return (
                <li key={allocation.traderId} className="rounded-md bg-inset p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="num block min-w-0 truncate text-sm" title={allocation.address}>
                      {label}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-destructive hover:text-destructive"
                      aria-label={`Remove ${label}`}
                      onClick={() => onRemove(allocation.traderId)}
                    >
                      Remove
                    </Button>
                  </div>

                  {mode === 'portfolio' ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <input
                        type="range"
                        min={MIN_WEIGHT_PCT}
                        max={TOTAL_PCT}
                        step={1}
                        value={allocation.weightPct}
                        aria-label={`Allocation weight for ${label}, in percent`}
                        aria-describedby={`weight-unit-${allocation.traderId}${errorId}`}
                        onChange={(event) =>
                          onWeight(allocation.traderId, Number(event.target.value))
                        }
                        className="h-1.5 w-28 accent-[var(--accent)]"
                      />
                      <div className="w-16 shrink-0">
                        <input
                          type="number"
                          min={MIN_WEIGHT_PCT}
                          max={TOTAL_PCT}
                          step={1}
                          className="field text-center"
                          value={allocation.weightPct}
                          aria-label={`Allocation weight for ${label}, in percent`}
                          aria-describedby={`weight-unit-${allocation.traderId}${errorId}`}
                          onChange={(event) =>
                            onWeight(allocation.traderId, Number(event.target.value))
                          }
                        />
                      </div>
                      <span
                        id={`weight-unit-${allocation.traderId}`}
                        className="text-xs text-fg-tertiary"
                      >
                        %
                      </span>
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-fg-tertiary">
                      Single Trader mode always allocates 100%.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {showError && error ? <FieldError id="allocations-error" message={error} /> : null}
      </PanelBody>
    </Panel>
  );
}

function RiskParamsForm({
  riskParams,
  errors,
  showErrors,
  onRisk,
}: {
  riskParams: RiskParams;
  errors: FormErrors;
  showErrors: boolean;
  onRisk: (patch: Partial<RiskParams>) => void;
}) {
  const slippageBps = toNumber(riskParams.slippageBps);
  return (
    <Panel>
      <PanelHeader title="Risk parameters" />
      <PanelBody>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <NumberField
            id="max-leverage"
            label="Max leverage"
            value={riskParams.maxLeverage}
            min={1}
            max={10}
            step={0.5}
            error={errors.maxLeverage}
            showError={showErrors}
            help="Maximum position leverage multiplier (1x–10x)."
            onChange={(raw) => onRisk({ maxLeverage: Number(raw) })}
          />
          <NumberField
            id="max-position-usd"
            label="Max position size (USD)"
            value={riskParams.maxPositionUsd ?? ''}
            min={100}
            step={100}
            placeholder="No limit"
            error={errors.maxPositionUsd}
            showError={showErrors}
            help="Optional cap on the size of any single position."
            onChange={(raw) => onRisk({ maxPositionUsd: raw === '' ? null : Number(raw) })}
          />
          <NumberField
            id="slippage-bps"
            label="Slippage tolerance"
            value={riskParams.slippageBps}
            min={0}
            max={100}
            step={1}
            error={errors.slippageBps}
            showError={showErrors}
            help={`${slippageBps} bps (${formatPercent(slippageBps / 100, 2)}) maximum acceptable slippage.`}
            onChange={(raw) => onRisk({ slippageBps: Number(raw) })}
          />
          <NumberField
            id="min-order-usd"
            label="Min order size (USD)"
            value={riskParams.minOrderUsd}
            min={5}
            step={5}
            error={errors.minOrderUsd}
            showError={showErrors}
            help="Orders below this size are skipped."
            onChange={(raw) => onRisk({ minOrderUsd: Number(raw) })}
          />
        </div>
      </PanelBody>
    </Panel>
  );
}

function CopySettingsForm({
  settings,
  error,
  showError,
  onSetting,
}: {
  settings: Settings;
  error?: string;
  showError: boolean;
  onSetting: (patch: Partial<Settings>) => void;
}) {
  const thresholdBps = toNumber(settings.rebalanceThresholdBps);
  return (
    <Panel>
      <PanelHeader title="Copy settings" />
      <PanelBody className="space-y-3">
        <ToggleRow
          id="follow-new-entries"
          label="Follow new entries only"
          description="Only copy new trades — don't sync positions that are already open."
          checked={settings.followNewEntriesOnly}
          onChange={(checked) => onSetting({ followNewEntriesOnly: checked })}
        />
        <ToggleRow
          id="auto-rebalance"
          label="Auto rebalance"
          description="Rebalance automatically when positions drift from the target allocation."
          checked={settings.autoRebalance}
          onChange={(checked) => onSetting({ autoRebalance: checked })}
        />
        <NumberField
          id="rebalance-threshold"
          label="Rebalance threshold"
          value={settings.rebalanceThresholdBps}
          min={0}
          max={500}
          step={5}
          disabled={!settings.autoRebalance}
          error={error}
          showError={showError}
          help={
            <>
              Trigger a rebalance when allocation drifts by {thresholdBps} bps (
              {formatPercent(thresholdBps / 100, 2)}).
              {settings.autoRebalance ? '' : ' Disabled while Auto Rebalance is off.'}
            </>
          }
          onChange={(raw) => onSetting({ rebalanceThresholdBps: Number(raw) })}
        />
      </PanelBody>
    </Panel>
  );
}

function NewStrategyPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { trader: requestedTrader } = Route.useSearch();

  const [state, dispatch] = useReducer(formReducer, INITIAL_STATE);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const topTradersQuery = useQuery({
    queryKey: [
      'traders',
      {
        limit: String(TRADER_LIMIT),
        sortBy: 'pnl',
        sortOrder: 'desc',
        timeframe: '7d',
        isActive: 'true',
      },
    ],
    // The ranking barely moves inside five minutes; without this the directory
    // refetched on every mount of the page.
    staleTime: TRADER_FRESH_MS,
    queryFn: async (): Promise<TraderOption[]> => {
      const res = await api.traders.$get({
        query: {
          limit: String(TRADER_LIMIT),
          sortBy: 'pnl',
          sortOrder: 'desc',
          timeframe: '7d',
          isActive: 'true',
        },
      });
      const body = await readJson<{ traders: TraderRow[] }>(res, 'Top traders');
      return body.traders.map((trader) => ({
        traderId: trader.traderId,
        address: trader.address,
        pnl7d: toNumber(trader.pnl7d),
        winRate: toNumber(trader.winrate),
      }));
    },
  });

  const directory: TraderDirectory = {
    traders: topTradersQuery.data ?? [],
    isPending: topTradersQuery.isPending,
    isError: topTradersQuery.isError,
    error: topTradersQuery.error,
    retry: () => void topTradersQuery.refetch(),
  };

  // `?trader=<address>`: resolve the address to the trader id the API needs,
  // then hand it to the reducer like any other pick.
  const preselectedAddress =
    requestedTrader && requestedTrader.length === 42 ? requestedTrader : null;

  const preselectedQuery = useQuery({
    queryKey: ['trader', preselectedAddress],
    enabled: preselectedAddress !== null,
    staleTime: TRADER_FRESH_MS,
    queryFn: async (): Promise<TraderOption> => {
      if (!preselectedAddress) throw new Error('No trader was requested');
      const res = await api.traders[':address'].$get({ param: { address: preselectedAddress } });
      const body = await readJson<{ trader: TraderRow }>(res, 'Trader');
      return {
        traderId: body.trader.traderId,
        address: body.trader.address,
        pnl7d: toNumber(body.trader.pnl7d),
        winRate: toNumber(body.trader.winrate),
      };
    },
  });

  const appliedPreselection = useRef(false);
  useEffect(() => {
    if (appliedPreselection.current) return;
    const trader = preselectedQuery.data;
    if (!trader) return;
    appliedPreselection.current = true;
    dispatch({ type: 'addTrader', trader });
  }, [preselectedQuery.data]);

  const errors = useMemo(() => validate(state), [state]);
  const blocking = blockingReason(errors);
  const totalPct = state.allocations.reduce((sum, allocation) => sum + allocation.weightPct, 0);

  const createStrategy = useMutation({
    mutationFn: async (form: FormState) => {
      const res = await api.strategies.$post({
        json: {
          name: form.name.trim(),
          description: form.description.trim() || undefined,
          mode: form.mode,
          riskParams: {
            maxLeverage: form.riskParams.maxLeverage,
            maxPositionUsd: form.riskParams.maxPositionUsd ?? undefined,
            slippageBps: form.riskParams.slippageBps,
            minOrderUsd: form.riskParams.minOrderUsd,
          },
          settings: form.settings,
          allocations: form.allocations.map((allocation) => ({
            traderId: allocation.traderId,
            weight: allocation.weightPct / 100,
          })),
        },
      });
      return readJson<{ id: string }>(res, 'Create strategy');
    },
    onSuccess: async () => {
      // The list the user lands on must not be served from cache: invalidate
      // first, then navigate.
      await queryClient.invalidateQueries({ queryKey: ['strategies'] });
      await navigate({ to: '/strategies' });
    },
  });

  const mutationError = createStrategy.error;
  const mutationMessage =
    mutationError instanceof ApiError
      ? mutationError.status === 401
        ? 'Sign in to create a strategy.'
        : mutationError.message
      : mutationError instanceof Error
        ? mutationError.message
        : 'The strategy could not be created.';

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttempted(true);
    if (blocking !== null || createStrategy.isPending) return;
    createStrategy.mutate(state);
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        title="Create new copy strategy"
        description="Configure an automated strategy that follows the traders you choose."
      />

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <StrategyBasics
          name={state.name}
          description={state.description}
          mode={state.mode}
          error={errors.name}
          showError={attempted}
          onBasic={(patch) => dispatch({ type: 'basic', patch })}
          onMode={(mode) => dispatch({ type: 'mode', mode })}
        />

        <AllocationEditor
          mode={state.mode}
          allocations={state.allocations}
          totalPct={totalPct}
          error={errors.allocations}
          showError={attempted}
          pickerOpen={pickerOpen}
          onTogglePicker={() => setPickerOpen((open) => !open)}
          directory={directory}
          onAdd={(trader) => dispatch({ type: 'addTrader', trader })}
          onRemove={(traderId) => dispatch({ type: 'removeTrader', traderId })}
          onWeight={(traderId, weightPct) => dispatch({ type: 'weight', traderId, weightPct })}
          requested={
            preselectedAddress
              ? {
                  address: preselectedAddress,
                  isPending: preselectedQuery.isPending,
                  isError: preselectedQuery.isError,
                  retry: () => void preselectedQuery.refetch(),
                }
              : null
          }
        />

        <RiskParamsForm
          riskParams={state.riskParams}
          errors={errors}
          showErrors={attempted}
          onRisk={(patch) => dispatch({ type: 'risk', patch })}
        />

        <CopySettingsForm
          settings={state.settings}
          error={errors.rebalanceThresholdBps}
          showError={attempted}
          onSetting={(patch) => dispatch({ type: 'setting', patch })}
        />

        <div className="space-y-3">
          {createStrategy.isError ? <ErrorNotice message={mutationMessage} /> : null}

          {blocking ? (
            <p
              role="status"
              className={cn('text-xs', attempted ? 'text-warning' : 'text-fg-tertiary')}
            >
              {blocking}
            </p>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Link
              to="/strategies"
              className={cn(
                buttonVariants({ variant: 'outline', size: 'lg' }),
                'w-full sm:w-auto sm:flex-1',
              )}
            >
              Cancel
            </Link>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full sm:w-auto sm:flex-1"
              disabled={createStrategy.isPending}
            >
              {createStrategy.isPending ? 'Creating…' : 'Create strategy'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
