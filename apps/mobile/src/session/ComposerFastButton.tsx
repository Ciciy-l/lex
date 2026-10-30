import { Zap } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable } from 'react-native';
import { iconSize, iconStroke, radius, useTheme } from '@/theme';

/** Same live preference as the model picker; long press explains the icon. */
export function ComposerFastButton({ enabled, disabled = false, onChange, testID }: {
  enabled: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
  testID?: string;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const label = t(enabled ? 'models.options.fastDisable' : 'models.options.fastEnable');
  const color = enabled ? colors.textPrimary : colors.textSecondary;
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: enabled, disabled }}
      accessibilityHint={disabled ? t('models.options.fastUnavailable') : undefined}
      disabled={disabled}
      hitSlop={8}
      onPress={() => onChange(!enabled)}
      onLongPress={() => Alert.alert(t('models.options.fastMode'), label)}
      style={({ pressed }) => ({
        width: 28, height: 28, flexShrink: 0,
        alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill,
        backgroundColor: enabled ? colors.surfaceChip : undefined,
        opacity: disabled ? 0.5 : pressed ? 0.6 : 1,
      })}
      testID={testID}
    >
      <Zap color={color} fill={enabled ? color : 'none'} size={iconSize.sm} strokeWidth={iconStroke.regular} />
    </Pressable>
  );
}
