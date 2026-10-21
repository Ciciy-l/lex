/**
 * useSignInToCindy — 从应用内发起 Cindy 登录的唯一正确通路。
 *
 * Keep the current owner while choosing an account service and signing in.
 * The existing add-account flow switches owners only after login succeeds;
 * cancellation returns to the current page without a guest-owner round trip.
 */

import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

export function useSignInToCindy(): () => Promise<void> {
  const navigate = useNavigate();
  const location = useLocation();

  return useCallback(async () => {
    navigate('/add-account', {
      state: { returnTo: location.pathname + location.search + location.hash },
    });
  }, [location.pathname, location.search, location.hash, navigate]);
}
