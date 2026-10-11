import { useTranslation } from 'react-i18next';
import { HarnessVersionsSection } from './HarnessVersionsSection';
import { UserPromptSection } from './UserPromptSection';
import { MemorySection } from './MemorySection';
import { SubagentModelSection } from './SubagentModelSection';
import { CompactionSection } from './CompactionSection';
import { PiPackagesSection } from './PiPackagesSection';
import { OmpHarnessControls, useOmpHarnessSettings } from './OmpHarnessControls';

export function HarnessSettingsSection() {
  const { t } = useTranslation();
  const omp = useOmpHarnessSettings();
  return (
    <div className="flex flex-col gap-8">
      <p className="text-13 text-[var(--settings-section-desc)]">
        {t('settings.harness.description')}
      </p>
      <section id="settings-harness-versions">
        <HarnessVersionsSection />
      </section>
      <section id="settings-search-target-personalization-user-prompt">
        <UserPromptSection />
      </section>
      <section id="settings-search-target-personalization-memory">
        <MemorySection />
        <OmpHarnessControls group="memory" controller={omp} />
      </section>
      <section id="settings-search-target-personalization-subagents">
        <SubagentModelSection />
        <OmpHarnessControls group="subagents" controller={omp} />
      </section>
      <section id="settings-search-target-personalization-compaction">
        <CompactionSection />
        <OmpHarnessControls group="compaction" controller={omp} />
      </section>
      <section id="settings-pi-extensions" className="flex flex-col gap-[14px]">
        <h2 className="text-16 font-medium text-[var(--settings-section-title)]">
          {t('settings.harness.extensions')}
        </h2>
        <PiPackagesSection />
      </section>
    </div>
  );
}
