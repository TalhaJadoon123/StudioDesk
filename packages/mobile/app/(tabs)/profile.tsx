import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useEffect, useState } from 'react';
import { API_URL, currentMemberId, signOut } from '../lib/api';
import { styles, theme } from '../lib/theme';

/** Profile: notifications, check-in, sign out. */
export default function ProfileScreen() {
  const router = useRouter();
  const memberId = currentMemberId();
  const [pushEnabled, setPushEnabled] = useState(false);

  useEffect(() => {
    void (async () => {
      const settings = await Notifications.getPermissionsAsync();
      setPushEnabled(settings.granted);
    })();
  }, []);

  async function enablePush(): Promise<void> {
    const result = await Notifications.requestPermissionsAsync();
    setPushEnabled(result.granted);
    if (result.granted) {
      await Notifications.setNotificationChannelAsync('waitlist', {
        name: 'Waitlist',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>You</Text>
      <Text style={styles.subheading}>
        {memberId ? `Signed in as ${memberId}` : 'Not signed in'}
      </Text>

      <Text style={styles.sectionTitle}>Check-in</Text>
      <View style={styles.card}>
        <Text style={styles.title}>Scan or tap</Text>
        <Text style={styles.meta}>
          Check in with your QR code, or let the studio tap you in at the desk.
        </Text>
        <TouchableOpacity
          style={[styles.button, { marginTop: 12 }]}
          onPress={() => router.push('/check-in')}
        >
          <Text style={styles.buttonText}>Check in now</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionTitle}>Notifications</Text>
      <View style={styles.card}>
        <Text style={styles.title}>Waitlist and class alerts</Text>
        <Text style={styles.meta}>
          {pushEnabled
            ? 'Enabled. You will be told the moment a spot opens up.'
            : 'Off. Turn them on so you get told when you come off a waitlist.'}
        </Text>
        {!pushEnabled ? (
          <TouchableOpacity
            style={[styles.buttonGhost, { marginTop: 12 }]}
            onPress={enablePush}
          >
            <Text style={styles.buttonGhostText}>Turn on notifications</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <Text style={styles.sectionTitle}>Connection</Text>
      <View style={styles.card}>
        <Text style={styles.meta}>API</Text>
        <Text style={{ fontFamily: 'monospace', fontSize: 12, color: theme.text }}>
          {API_URL}
        </Text>
        {!process.env.EXPO_PUBLIC_API_URL ? (
          <Text style={[styles.meta, { marginTop: 8 }]}>
            Using the local default. Set EXPO_PUBLIC_API_URL before shipping.
          </Text>
        ) : null}
      </View>

      {memberId ? (
        <TouchableOpacity
          style={[styles.buttonGhost, { marginTop: 20 }]}
          onPress={async () => {
            await signOut();
            router.replace('/sign-in');
          }}
        >
          <Text style={styles.buttonGhostText}>Sign out</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={[styles.button, { marginTop: 20 }]} onPress={() => router.push('/sign-in')}>
          <Text style={styles.buttonText}>Sign in</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}
