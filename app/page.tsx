import { requireOwnerPage } from '@/lib/auth';
import Workspace from './workspace';
export const dynamic = 'force-dynamic';
export default async function Home() { await requireOwnerPage(); return <Workspace/>; }
