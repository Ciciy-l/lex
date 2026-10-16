import { Redirect } from 'expo-router';

/** Old companion deep links no longer mount a task or issue remote calls. */
export default function RetiredCompanionRoute() {
  return <Redirect href="/devices" />;
}
