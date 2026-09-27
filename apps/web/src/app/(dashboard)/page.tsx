import {LiveOverview} from '@/components/live-overview';
import {getOverview} from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  return <LiveOverview initialData={await getOverview()} />;
}
