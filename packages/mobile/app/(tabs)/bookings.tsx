import { useCallback, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { api, currentMemberId, type MyBooking } from '../lib/api';
import { dayTime, when } from '../lib/format';
import { styles, theme } from '../lib/theme';

/** Upcoming and past bookings, with cancel and waitlist-position controls. */
export default function BookingsScreen() {
  const router = useRouter();
  const [bookings, setBookings] = useState<MyBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const memberId = currentMemberId();
    if (!memberId) {
      setLoading(false);
      return;
    }
    try {
      setError(null);
      setBookings(await api.myBookings(memberId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your bookings');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load();
    }, [load]),
  );

  async function cancel(booking: MyBooking): Promise<void> {
    setBusyId(booking.id);
    setError(null);
    setNotice(null);
    try {
      const result = await api.cancel(booking.id);
      setNotice(
        result.late
          ? 'Cancelled. Because it was inside the late-cancel window, a fee applies.'
          : 'Cancelled. Your credit has been returned.',
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel');
    } finally {
      setBusyId(null);
    }
  }

  if (!currentMemberId()) {
    return (
      <View style={styles.center}>
        <Text style={styles.heading}>Sign in first</Text>
        <Text style={[styles.subheading, { textAlign: 'center' }]}>
          Your bookings live under your member account.
        </Text>
        <TouchableOpacity style={styles.button} onPress={() => router.push('/sign-in')}>
          <Text style={styles.buttonText}>Sign in</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const now = Date.now();
  const upcoming = bookings
    .filter((b) => (b.status === 'booked' || b.status === 'waitlisted') && Date.parse(b.startTime ?? '') >= now - 3_600_000)
    .sort((a, b) => a.startTime!.localeCompare(b.startTime!));
  const past = bookings
    .filter((b) => !upcoming.includes(b))
    .sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''))
    .slice(0, 20);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => {
          setRefreshing(true);
          void load();
        }} />
      }
    >
      <Text style={styles.heading}>My bookings</Text>
      <Text style={styles.subheading}>
        {upcoming.length} upcoming · {past.length} recent
      </Text>

      {error ? <View style={styles.error}><Text>{error}</Text></View> : null}
      {notice ? <View style={styles.success}><Text>{notice}</Text></View> : null}

      {loading ? (
        <ActivityIndicator color={theme.accent} style={{ marginTop: 24 }} />
      ) : (
        <>
          <Text style={styles.sectionTitle}>Upcoming</Text>
          {upcoming.length === 0 ? (
            <View style={styles.empty}>
              <Text>Nothing booked. Browse the schedule.</Text>
              <TouchableOpacity
                style={[styles.button, { marginTop: 12 }]}
                onPress={() => router.push('/(tabs)')}
              >
                <Text style={styles.buttonText}>See the schedule</Text>
              </TouchableOpacity>
            </View>
          ) : (
            upcoming.map((booking) => (
              <View style={styles.card} key={booking.id}>
                <View style={styles.rowBetween}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.title}>{booking.className ?? 'Class'}</Text>
                    <Text style={styles.meta}>
                      {dayTime(booking.startTime)} · {when(booking.startTime)}
                    </Text>
                  </View>
                  <Text
                    style={[
                      styles.badge,
                      booking.status === 'waitlisted' ? styles.badgeWarn : styles.badgeOk,
                    ]}
                  >
                    {booking.status === 'waitlisted'
                      ? `#${booking.waitlistPosition}`
                      : 'Booked'}
                  </Text>
                </View>

                <TouchableOpacity
                  style={[styles.buttonGhost, { marginTop: 12 }]}
                  disabled={busyId === booking.id}
                  onPress={() => cancel(booking)}
                >
                  <Text style={styles.buttonGhostText}>
                    {busyId === booking.id ? 'Cancelling...' : 'Cancel booking'}
                  </Text>
                </TouchableOpacity>
              </View>
            ))
          )}

          {past.length > 0 ? (
            <>
              <Text style={styles.sectionTitle}>Recent</Text>
              {past.map((booking) => (
                <View style={styles.cardTight} key={booking.id}>
                  <View style={styles.rowBetween}>
                    <Text style={styles.title}>{booking.className ?? 'Class'}</Text>
                    <Text
                      style={[
                        styles.badge,
                        booking.status === 'attended'
                          ? styles.badgeOk
                          : booking.status === 'no-show'
                            ? styles.badgeDanger
                            : styles.badgeNeutral,
                      ]}
                    >
                      {booking.status}
                    </Text>
                  </View>
                  <Text style={[styles.meta, { marginTop: 4 }]}>{dayTime(booking.startTime)}</Text>
                </View>
              ))}
            </>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}
