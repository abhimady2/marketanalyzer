import { getLatestSnapshot, runAnalysis, type Snapshot } from '@/lib/engine/analyze';
import Dashboard from '@/components/Dashboard';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export default async function Home() {
  const snap: Snapshot = (await getLatestSnapshot()) ?? (await runAnalysis(false));
  return <Dashboard initial={snap} />;
}
