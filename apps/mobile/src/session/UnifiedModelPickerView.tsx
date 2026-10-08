import type { ReactNode } from "react";
import {
  Star,
  SlidersHorizontal,
  Check,
  Zap,
  LayoutGrid,
} from "lucide-react-native";
import { MobileAgentMark } from "@/components/MobileAgentMark";
import { MobileModelIconMark, MobileProviderMark } from "./MobileProviderMark";
import { useState } from "react";
import { Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { Text, TextInput } from "@/components/AppText";
import { useTheme, spacing, radius, iconSize } from "@/theme";
import { SheetModal } from "./SheetModal";
import { SheetSurface } from "./SheetSurface";
import {
  computeContextSheetSnapHeights,
  type ContextSheetSnap,
} from "./contextSheetModel";
import { mobileAgentLabel } from "./sessionAgentSwitch";
import type {
  UnifiedMobilePickerViewProps,
  UnifiedMobileRow,
} from "./UnifiedModelPickerSheet";
import { mobileInteractionStyles } from "@/components/mobileInteractionStyles";

type Page = "sources" | "harness" | null;

/** 分组:可选小标题 + 行间 hairline(与 ContextSheetGroup 的安卓分组行同一套节奏)。 */
function Group({
  title,
  children,
  testID,
}: {
  title?: string;
  children: ReactNode;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const rows = flatten(children);
  return (
    <View style={styles.group} testID={testID}>
      {title ? <Text style={styles.groupLabel}>{title}</Text> : null}
      {rows.map((row, index) => (
        <View key={index}>
          {index > 0 ? <View style={styles.separator} /> : null}
          {row}
        </View>
      ))}
    </View>
  );
}

function flatten(children: ReactNode): ReactNode[] {
  if (
    children === null ||
    children === undefined ||
    typeof children === "boolean"
  )
    return [];
  if (Array.isArray(children)) return children.flatMap(flatten);
  return [children];
}

/** 设置页 / 来源页的单行:leading + 标题(+副标题)+ 右侧取值 / 勾号 / chevron。 */
function Row({
  title,
  subtitle,
  value,
  leading,
  trailing,
  selected,
  disabled,
  onPress,
  accessibilityLabel,
  testID,
}: {
  title: string;
  subtitle?: string | null;
  value?: string | null;
  leading?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onPress(): void;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={
        accessibilityLabel ??
        [title, subtitle, value].filter(Boolean).join(", ")
      }
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        disabled && styles.rowDisabled,
        pressed && styles.pressed,
      ]}
      testID={testID}
    >
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.rowMain}>
        <Text numberOfLines={1} style={styles.rowTitle}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={styles.rowSubtitle}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text numberOfLines={1} style={styles.rowValue}>
          {value}
        </Text>
      ) : null}
      {trailing}
      {selected ? (
        <Check
          color={colors.textPrimary}
          size={iconSize.lg}
          strokeWidth={iconStroke.medium}
        />
      ) : null}
    </Pressable>
  );
}

function QuotaBar({
  remaining,
  label,
  testID,
}: {
  remaining: number;
  label: string;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const now = Math.max(0, Math.min(100, remaining));
  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now }}
      style={styles.quotaTrack}
      testID={testID}
    >
      <View style={[styles.quotaFill, { width: `${now}%` }]} />
    </View>
  );
}

export function UnifiedModelPickerView(p: UnifiedMobilePickerViewProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [snap, setSnap] = useState<ContextSheetSnap>("half");
  const button = (
    label: string,
    onPress: () => void,
    selected = false,
    icon?: ReactNode,
    disabled = false,
  ) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={p.busy || disabled}
      onPress={onPress}
      style={{
        opacity: disabled ? 0.4 : 1,
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.sm,
        minHeight: 44,
        padding: spacing.md,
        backgroundColor: selected ? colors.surfaceChip : undefined,
        borderRadius: radius.pill,
      }}
    >
      {icon}
      <Text style={{ color: colors.textPrimary }}>{label}</Text>
    </Pressable>
  );
  const o = p.options;
  return (
    <SheetModal
      visible={p.visible}
      onClosed={p.onClosed}
      onBackdropPress={p.onClose}
      onRequestClose={p.onBack ?? p.onClose}
      keyboardAvoiding
    >
      <SheetSurface
        title={p.title}
        onBack={p.onBack}
        onClose={p.onClose}
        heights={computeContextSheetSnapHeights({
          screenHeight: height,
          safeAreaTopInset: insets.top,
        })}
        snap={snap}
        onSnapChange={setSnap}
        bottomInset={insets.bottom}
        testID={p.testID}
      >
        {p.error ? (
          <Text style={{ color: colors.errorText }}>{p.error}</Text>
        ) : null}
        {o ? (
          <>
            <Text style={{ color: colors.textSecondary }}>{o.context}</Text>
            <Text>{t("models.unified.harness")}</Text>
            {o.agents.map((agent) =>
              button(
                mobileAgentLabel(agent),
                () => {
                  const cap = o.row.entry.capabilities[agent]!;
                  o.onChange({
                    ...o.row.config,
                    agent,
                    modelId: cap.wireModelId,
                    effort: cap.defaultEffort ?? cap.efforts[0] ?? "",
                    fast: false,
                  });
                },
                agent === o.row.config.agent,
                <MobileAgentMark
                  agentKind={agent}
                  color={colors.textSecondary}
                />,
              ),
            )}
            <Text>{t("models.options.reasoningEffort")}</Text>
            {o.row.entry.capabilities[o.row.config.agent]?.efforts.map(
              (effort) =>
                button(
                  t(`models.options.effortLevels.${effort}`),
                  () => o.onChange({ ...o.row.config, effort }),
                  effort === o.row.config.effort,
                ),
            )}
            {o.fastCapable
              ? button(
                  t("models.options.fastMode"),
                  () =>
                    o.onChange({ ...o.row.config, fast: !o.row.config.fast }),
                  o.row.config.fast,
                  <Zap
                    size={iconSize.action}
                    color={colors.textSecondary}
                    fill={colors.textSecondary}
                  />,
                )
              : null}
            {o.price ? <Text>{o.price}</Text> : null}
            {button(
              t(
                o.row.favorite
                  ? "models.unified.removeFavorite"
                  : "models.unified.addFavorite",
              ),
              o.onFavorite,
              false,
              <Star
                size={iconSize.action}
                color={colors.textSecondary}
                fill={o.row.favorite ? colors.textSecondary : "none"}
              />,
              o.favoritesDisabled,
            )}
            {!o.row.favorite
              ? button(t("models.unified.restoreRecommended"), o.onReset)
              : null}
          </>
        ) : (
          <>
            <TextInput
              value={p.query}
              onChangeText={p.onQuery}
              placeholder={t("models.picker.searchPlaceholder")}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: spacing.sm,
                minHeight: 44,
                color: colors.textPrimary,
              }}
            />
            <ScrollView horizontal>
              {p.filters.map((item) =>
                button(
                  item.quota
                    ? `${item.label} · ${item.quota.label}`
                    : item.label,
                  () => p.onFilter(item.id),
                  p.filter === item.id,
                  item.providerMark ? (
                    <View
                      accessibilityLabel={item.quota?.label}
                      style={{ alignItems: "center", gap: spacing.xs }}
                    >
                      <MobileProviderMark {...item.providerMark} />
                      {item.quota ? (
                        <View
                          accessibilityRole="progressbar"
                          accessibilityValue={{
                            min: 0,
                            max: 100,
                            now: item.quota.remaining,
                          }}
                          style={{
                            width: 24,
                            height: 3,
                            borderRadius: radius.pill,
                            backgroundColor: colors.surfaceChip,
                            overflow: "hidden",
                          }}
                        >
                          <View
                            style={{
                              width: `${item.quota.remaining}%`,
                              height: "100%",
                              backgroundColor: colors.textSecondary,
                            }}
                          />
                        </View>
                      ) : null}
                    </View>
                  ) : item.id === "favorites" ? (
                    <Star size={iconSize.action} color={colors.textSecondary} />
                  ) : (
                    <LayoutGrid
                      size={iconSize.action}
                      color={colors.textSecondary}
                    />
                  ),
                ),
              )}
            </ScrollView>
            {p.groups.map((group) => (
              <View key={group.key}>
                <Text style={{ color: colors.textSecondary }}>
                  {group.title}
                </Text>
                {group.rows.map((row) => (
                  <View
                    key={row.key}
                    style={{ flexDirection: "row", alignItems: "center" }}
                  >
                    <Pressable
                      disabled={p.busy || row.disabled}
                      onPress={() => p.onSelect(row)}
                      style={{
                        flex: 1,
                        minHeight: 52,
                        padding: 12,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: spacing.sm,
                      }}
                    >
                      <MobileModelIconMark
                        icon={row.entry.icon}
                        {...row.providerMark}
                      />
                      <View style={{ flex: 1 }}>
                        <View
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: spacing.xs,
                          }}
                        >
                          <Text
                            numberOfLines={1}
                            style={{ color: colors.textPrimary, flexShrink: 1 }}
                          >
                            {row.entry.displayName}
                          </Text>
                          {row.costMarks ? (
                            <Text style={{ color: colors.textSecondary }}>
                              {row.costMarks}
                            </Text>
                          ) : null}
                          <MobileAgentMark
                            agentKind={row.config.agent}
                            color={colors.textSecondary}
                          />
                          <Text style={{ color: colors.textSecondary }}>
                            {row.effortLabel}
                          </Text>
                          {row.config.fast ? (
                            <Zap
                              size={iconSize.sm}
                              color={colors.textSecondary}
                            />
                          ) : null}
                        </View>
                        {row.subtitle ? (
                          <Text numberOfLines={1} style={{ color: colors.textSecondary }}>
                            {row.subtitle}
                          </Text>
                        ) : null}
                        {row.quotaLabel ? (
                          <Text style={{ color: colors.textSecondary }}>
                            {row.quotaLabel}
                          </Text>
                        ) : null}
                      </View>
                      {row.favorite ? (
                        <Star
                          size={iconSize.action}
                          color={colors.textSecondary}
                          fill={colors.textSecondary}
                        />
                      ) : null}
                      {row.selected ? (
                        <Check
                          size={iconSize.action}
                          color={colors.textSecondary}
                        />
                      ) : null}
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t(
                        "models.picker.configureAccessibility",
                        { model: row.entry.displayName },
                      )}
                      disabled={p.busy || row.disabled}
                      onPress={() => p.onOptions(row)}
                      style={{
                        width: 44,
                        height: 44,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <SlidersHorizontal
                        size={iconSize.action}
                        color={colors.textSecondary}
                      />
                    </Pressable>
                  </View>
                ))}
              </View>
            ))}
            {!p.groups.length ? (
              <Text>
                {p.loading ? t("models.picker.loadingDefault") : p.emptyHint}
              </Text>
            ) : null}
          </>
        )}
      </SheetSurface>
    </SheetModal>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    searchRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing.sm,
      paddingBottom: spacing.sm,
    },
    searchField: {
      alignItems: "center",
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      flex: 1,
      flexDirection: "row",
      gap: spacing.sm,
      minHeight: 44,
      minWidth: 0,
      paddingLeft: spacing.md,
      paddingRight: spacing.xs,
    },
    searchInput: {
      color: colors.textPrimary,
      flex: 1,
      fontSize: typeScale.bodySmall,
      minWidth: 0,
      paddingVertical: spacing.sm,
    },
    iconButton: {
      alignItems: "center",
      height: 36,
      justifyContent: "center",
      width: 36,
    },
    sourceButton: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing.xs,
      maxWidth: 140,
      minHeight: 44,
    },
    sourceLabel: {
      color: colors.textSecondary,
      flexShrink: 1,
      fontSize: typeScale.bodySmall,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.bodySmall,
    },
    markBox: {
      alignItems: "center",
      height: 24,
      justifyContent: "center",
      width: 24,
    },
    group: {
      paddingTop: spacing.lg,
    },
    groupLabel: {
      color: colors.textTertiary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.semibold,
      lineHeight: lineHeight.caption,
      paddingBottom: spacing.xs,
    },
    separator: {
      backgroundColor: colors.border,
      height: StyleSheet.hairlineWidth,
    },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing.md,
      minHeight: 48,
      paddingVertical: spacing.xs,
    },
    rowDisabled: {
      opacity: 0.4,
    },
    pressed: mobileInteractionStyles.pressed,
    leading: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: 28,
      width: 28,
    },
    rowMain: {
      flex: 1,
      minWidth: 0,
    },
    rowTitle: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.body,
    },
    rowSubtitle: {
      color: colors.textSecondary,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.regular,
      lineHeight: lineHeight.caption,
    },
    rowValue: {
      color: colors.textSecondary,
      flexShrink: 1,
      fontSize: typeScale.body,
      fontWeight: fontWeight.regular,
      lineHeight: lineHeight.body,
      maxWidth: "50%",
    },
    sourceLeading: {
      alignItems: "center",
      gap: spacing.xs,
    },
    quotaTrack: {
      backgroundColor: colors.surfaceChip,
      borderRadius: radius.pill,
      height: 3,
      overflow: "hidden",
      width: 24,
    },
    quotaFill: {
      backgroundColor: colors.textSecondary,
      height: "100%",
    },
    modelRow: {
      alignItems: "center",
      flexDirection: "row",
    },
    modelMain: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
      gap: spacing.md,
      minHeight: 56,
      minWidth: 0,
      paddingVertical: spacing.sm,
    },
    titleLine: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing.xs,
      minWidth: 0,
    },
    titleText: {
      flexShrink: 1,
    },
    meta: {
      color: colors.textSecondary,
      flexShrink: 0,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.regular,
      lineHeight: lineHeight.caption,
    },
    quotaText: {
      color: colors.textTertiary,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.regular,
      lineHeight: lineHeight.caption,
    },
    optionsButton: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    footnote: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.regular,
      lineHeight: lineHeight.caption,
      paddingTop: spacing.md,
    },
    price: {
      paddingTop: spacing.lg,
    },
    empty: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      paddingVertical: spacing.lg,
      textAlign: "center",
    },
    error: {
      color: colors.errorText,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      paddingTop: spacing.md,
    },
  });
}
