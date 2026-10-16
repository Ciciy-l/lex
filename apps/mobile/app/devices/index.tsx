import { useAuth } from '@/auth/AuthContext';
import { MobileHome } from '@/session/HomeSurface';

export default function HomeScreen() {
  const { accountGeneration } = useAuth();
  return <MobileHome key={accountGeneration} />;
}

export { PROJECT_PREVIEW_LIMIT, HomeSessionRow } from '@/session/HomeSurface';
