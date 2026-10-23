import { useAuth } from '@/auth/AuthContext';
import { MobileHome } from '@/session/HomeSurface';
import { GuestHome } from '@/auth/GuestHome';

export default function HomeScreen() {
  const { accountGeneration, isAuthenticated } = useAuth();
  if (!isAuthenticated) return <GuestHome />;
  return <MobileHome key={accountGeneration} />;
}

export { PROJECT_PREVIEW_LIMIT, HomeSessionRow } from '@/session/HomeSurface';
