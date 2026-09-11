import { createFileRoute } from '@tanstack/react-router';
import { Flame, LineChart, Scale, Waves, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { FundingHeatmap } from '~/components/analytics/FundingHeatmap';
import { OiPanel } from '~/components/analytics/OiPanel';
import { PriceHeatmap } from '~/components/analytics/PriceHeatmap';
import { StressHeatmap } from '~/components/analytics/StressHeatmap';
import { WhaleFlows } from '~/components/analytics/WhaleFlows';
import { PageHeader } from '~/components/ui/page-header';
import { Segmented } from '~/components/ui/segmented';

export type AnalyticsTab = 'oi' | 'funding' | 'price' | 'stress' | 'whales';

const TABS: Array<{ value: AnalyticsTab; label: string; shortLabel: string; icon: ReactNode }> = [
  {
    value: 'oi',
    label: 'Open Interest',
    shortLabel: 'OI',
    icon: <Scale aria-hidden="true" />,
  },
  {
    value: 'funding',
    label: 'Funding',
    shortLabel: 'Funding',
    icon: <Zap aria-hidden="true" />,
  },
  { value: 'price', label: 'Price', shortLabel: 'Price', icon: <LineChart aria-hidden="true" /> },
  {
    value: 'stress',
    label: 'Stress',
    shortLabel: 'Stress',
    icon: <Flame aria-hidden="true" />,
  },
  {
    value: 'whales',
    label: 'Whale flows',
    shortLabel: 'Whales',
    icon: <Waves aria-hidden="true" />,
  },
];

const TAB_VALUES = TABS.map((tab) => tab.value);

/** Validate the `?tab=` search param so an analytics view is linkable. */
export const Route = createFileRoute('/analytics')({
  validateSearch: (search: Record<string, unknown>) => {
    const tab = search.tab;
    return {
      tab: TAB_VALUES.includes(tab as AnalyticsTab) ? (tab as AnalyticsTab) : 'oi',
    };
  },
  component: AnalyticsPage,
});

function AnalyticsPage() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <div>
      <PageHeader
        title="Market analytics"
        description="Open interest, funding, price and stress heatmaps across Hyperliquid markets."
      />

      <div className="mb-3">
        <Segmented
          items={TABS.map((item) => ({
            value: item.value,
            label: (
              <>
                <span className="hidden sm:inline">{item.label}</span>
                <span className="sm:hidden">{item.shortLabel}</span>
              </>
            ),
            icon: item.icon,
          }))}
          value={tab}
          onChange={(next) => void navigate({ search: { tab: next } })}
          label="Analytics view"
          idBase="analytics"
        />
      </div>

      <div
        role="tabpanel"
        id={`analytics-panel-${tab}`}
        aria-labelledby={`analytics-tab-${tab}`}
        tabIndex={-1}
      >
        {tab === 'oi' ? <OiPanel /> : null}
        {tab === 'funding' ? <FundingHeatmap /> : null}
        {tab === 'price' ? <PriceHeatmap /> : null}
        {tab === 'stress' ? <StressHeatmap /> : null}
        {tab === 'whales' ? <WhaleFlows /> : null}
      </div>
    </div>
  );
}
