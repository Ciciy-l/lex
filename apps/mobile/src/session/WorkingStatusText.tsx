import type { StyleProp, TextStyle } from 'react-native';
import { Text } from '@/components/AppText';

export function WorkingStatusText({ text, style }: { text: string; style?: StyleProp<TextStyle> }) {
  return <Text numberOfLines={1} style={style}>{text}</Text>;
}
