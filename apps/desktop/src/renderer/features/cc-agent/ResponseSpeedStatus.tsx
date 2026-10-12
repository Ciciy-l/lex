import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { responseSpeedActivity, responseSpeedHistory, type ResponseSpeedSnapshot } from '@cindy/maker-shared/usage-format';
import { RunningTokenRatePopover } from './RunningTokenRatePopover';
import { formatRecentOutputTokenRate } from './lib/runningTokenUsage';

/** Only the task's measured output enters this view; total billing tokens do not. */
export function ResponseSpeedStatus({ speed }: { speed: ResponseSpeedSnapshot }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (speed.phase === 'complete') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [speed.phase, speed.sampledAt]);
  const time = Math.max(now, Date.now());
  const activity = responseSpeedActivity(speed, time);
  const history = responseSpeedHistory(speed, time);
  const label = t(activity === 'failed' ? 'chat.runningStatus.responseFailed'
    : activity === 'cancelled' ? 'chat.runningStatus.responseCancelled'
    : activity === 'retrying' ? 'chat.runningStatus.responseRetrying'
    : activity === 'complete' ? 'chat.runningStatus.lastGeneration'
    : activity === 'tool' ? 'chat.runningStatus.toolRunning'
    : activity === 'paused' ? 'chat.runningStatus.generationPaused'
    : activity === 'generating' ? 'chat.runningStatus.responseGenerating'
    : 'chat.runningStatus.responsePending');
  const rate = history.latestRate === null ? null : formatRecentOutputTokenRate(history.latestRate);
  return <RunningTokenRatePopover responseSpeed={speed} elapsedText={label}
    rate={rate} rateText={rate === null ? null : t(speed.phase !== 'complete' || speed.estimated
      ? 'chat.runningStatus.estimatedTokenRate' : 'chat.runningStatus.tokenRate', { rate })}
    averageRate={speed.averageRate === null ? null : formatRecentOutputTokenRate(speed.averageRate)}
    outputTokens={speed.outputTokens} history={history} />;
}
