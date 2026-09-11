import { createFileRoute } from '@tanstack/react-router';
import { Flame, LineChart, Scale, Waves, Zap } from 'lucide-react';
import { useState } from 'react';
import { FundingHeatmap } from '~/components/analytics/FundingHeatmap';
import { OiPanel } from '~/components/analytics/OiPanel';
import { PriceHeatmap } from '~/components/analytics/PriceHeatmap';
import { StressHeatmap } from '~/components/analytics/StressHeatmap';
import { WhaleFlows } from '~/components/analytics/WhaleFlows';

export const Route = createFileRoute('/analytics')({
  component: AnalyticsPage,
});

type Tab = 'oi' | 'funding' | 'price' | 'stress' | 'whales';

const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
  { id: 'oi', label: 'Open Interest', icon: <Scale className="w-3.5 h-3.5" /> },
  { id: 'funding', label: 'Funding Heatmap', icon: <Zap className="w-3.5 h-3.5" /> },
  { id: 'price', label: 'Price Heatmap', icon: <LineChart className="w-3.5 h-3.5" /> },
  { id: 'stress', label: 'Stress (liquidation-like)', icon: <Flame className="w-3.5 h-3.5" /> },
  { id: 'whales', label: 'Whale Flows', icon: <Waves className="w-3.5 h-3.5" /> },
];

function AnalyticsPage() {
  const [tab, setTab] = useState<Tab>('oi');
  return (
    <div className="max-w-[1500px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">Market Analytics</h1>
        <p className="text-sm opacity-60 mt-0.5">
          Open interest, funding, price and stress heatmaps across Hyperliquid markets
        </p>
      </div>
      <div className="dock mb-5 w-fit">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className="dock-tab flex items-center gap-1.5"
            data-active={tab === t.id}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'oi' && <OiPanel />}
      {tab === 'funding' && <FundingHeatmap />}
      {tab === 'price' && <PriceHeatmap />}
      {tab === 'stress' && <StressHeatmap />}
      {tab === 'whales' && <WhaleFlows />}
    </div>
  );
}
