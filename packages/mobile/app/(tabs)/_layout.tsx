import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { theme } from '../../lib/theme';

/** Bottom tabs: schedule, my bookings, check in, profile. */
export default function TabsLayout() {
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.surface },
        headerTitleStyle: { color: theme.text, fontWeight: '600' },
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.muted2,
        tabBarStyle: {
          backgroundColor: theme.surface,
          borderTopColor: theme.border,
          height: 58 + insets.bottom,
          paddingBottom: insets.bottom + 6,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Schedule', tabBarLabel: 'Schedule', tabBarIcon: ({ color }) => <TabIcon glyph="▦" color={color} /> }}
      />
      <Tabs.Screen
        name="bookings"
        options={{ title: 'My bookings', tabBarIcon: ({ color }) => <TabIcon glyph="☰" color={color} /> }}
      />
      <Tabs.Screen
        name="wallet"
        options={{ title: 'Passes', tabBarIcon: ({ color }) => <TabIcon glyph="◈" color={color} /> }}
      />
      <Tabs.Screen
        name="profile"
        options={{ title: 'You', tabBarIcon: ({ color }) => <TabIcon glyph="☻" color={color} /> }}
      />
    </Tabs>
  );
}

/** Glyph-based tab icons - avoids pulling in an icon font for four symbols. */
function TabIcon({ glyph, color }: { glyph: string; color: string }) {
  return <Text style={{ fontSize: 18, color }}>{glyph}</Text>;
}
