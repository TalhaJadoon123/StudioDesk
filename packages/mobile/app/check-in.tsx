import { useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { api, currentMemberId } from '../lib/api';
import { styles, theme } from '../lib/theme';

type Mode = 'choose' | 'scan' | 'locating';

interface Result {
  ok: boolean;
  status: string;
  message: string;
  distanceMeters?: number;
}

/**
 * Check-in.
 *
 * Three paths, because a real studio needs all three:
 *   - scan the QR code the member is holding
 *   - confirm by GPS (geofenced, with an accuracy allowance)
 *   - ask staff to tap you in from the front desk
 */
export default function CheckInScreen() {
  const router = useRouter();
  const memberId = currentMemberId();
  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState<Mode>('choose');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleScan(code: string): Promise<void> {
    setMode('choose');
    setError(null);
    if (!memberId) {
      setError('Sign in before checking in.');
      return;
    }
    try {
      setResult(await api.checkin({ code, method: 'qr' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check in');
    }
  }

  async function checkInByLocation(): Promise<void> {
    setMode('locating');
    setError(null);
    if (!memberId) {
      setMode('choose');
      setError('Sign in before checking in.');
      return;
    }
    try {
      const services = await Location.requestForegroundPermissionsAsync();
      if (services.status !== 'granted') {
        setMode('choose');
        setError('Location permission is needed to confirm you are at the studio.');
        return;
      }
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const outcome = await api.checkin({
        method: 'geo',
        memberId,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      });
      setResult(outcome);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not confirm your location');
    } finally {
      setMode('choose');
    }
  }

  if (!memberId) {
    return (
      <View style={styles.center}>
        <Text style={styles.heading}>Sign in first</Text>
        <TouchableOpacity style={styles.button} onPress={() => router.push('/sign-in')}>
          <Text style={styles.buttonText}>Sign in</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Check in</Text>
      <Text style={styles.subheading}>Get within the studio geofence and we will log your visit.</Text>

      {error ? <View style={styles.error}><Text>{error}</Text></View> : null}

      {result ? (
        <View style={result.ok ? styles.success : styles.error}>
          <Text style={{ fontWeight: '600' }}>{result.ok ? 'Checked in' : 'Not this time'}</Text>
          <Text style={{ marginTop: 4 }}>{result.message}</Text>
          {typeof result.distanceMeters === 'number' ? (
            <Text style={{ marginTop: 4, fontSize: 12 }}>
              {Math.round(result.distanceMeters)}m from the studio pin
            </Text>
          ) : null}
        </View>
      ) : null}

      {mode === 'locating' ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
          <Text style={[styles.meta, { marginTop: 10 }]}>Finding you...</Text>
        </View>
      ) : mode === 'scan' ? (
        <View style={{ height: 420, borderRadius: theme.radius, overflow: 'hidden', marginBottom: 12 }}>
          {permission?.granted ? (
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => void handleScan(data)}
            />
          ) : (
            <View style={styles.center}>
              <Text style={styles.meta}>Camera permission needed.</Text>
              <TouchableOpacity
                style={[styles.button, { marginTop: 12 }]}
                onPress={requestPermission}
              >
                <Text style={styles.buttonText}>Allow camera</Text>
              </TouchableOpacity>
            </View>
          )}
          <TouchableOpacity
            style={[styles.buttonGhost, { marginTop: 10 }]}
            onPress={() => setMode('choose')}
          >
            <Text style={styles.buttonGhostText}>Cancel scan</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <View style={styles.card}>
            <Text style={styles.title}>Confirm by location</Text>
            <Text style={styles.meta}>
              Uses GPS. Works even when the studio wifi is down.
            </Text>
            <TouchableOpacity
              style={[styles.button, { marginTop: 12 }]}
              onPress={checkInByLocation}
            >
              <Text style={styles.buttonText}>I'm at the studio</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.card}>
            <Text style={styles.title}>Scan the studio QR</Text>
            <Text style={styles.meta}>
              Point your camera at the code by the door or on the front desk.
            </Text>
            <TouchableOpacity
              style={[styles.buttonGhost, { marginTop: 12 }]}
              onPress={() => setMode('scan')}
            >
              <Text style={styles.buttonGhostText}>Open camera</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.card}>
            <Text style={styles.title}>Ask the front desk</Text>
            <Text style={styles.meta}>
              Staff can tap you in from the tablet - no phone needed.
            </Text>
          </View>
        </>
      )}
    </ScrollView>
  );
}
