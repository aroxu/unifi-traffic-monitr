import {LiveOverview} from '@/components/live-overview';
import {getOverview} from '@/lib/queries';
import {requireSession} from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  await requireSession();
  return <LiveOverview initialData={await getOverview()} />;
}
