import { Platform } from "react-native";
import { isCindyMobileSession } from '@/auth/authService';

export function supportsAutoUnlock(hostPlatform: string | undefined) {
  return isCindyMobileSession() && Platform.OS === "ios" && hostPlatform === "darwin";
}
