import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { api, currentMemberId, type ClassSummary } from '../lib/api';
import { dayTime, time, upcomingDays, when } from '../lib/format';
import { styles, theme } from '../lib/theme';

/**
 * Browse and book.
 *
 * Days are a horizontal filter; the list below is whatever runs on the selected
 * day. Booking works whether the class is full (waitlist) or not.
 */
export default function ScheduleScreen() {
  const router = useRouter();
  const days = useMemo(() => upcomingDays(14), []);
  const [selected, setSelected] = useState(days[0]!.iso);
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [bookings, setBookings] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const dayStart = useMemo(() => `${selected.slice(0, 10)}T00:00:00.000Z`, [selected]);
  const dayEnd = useMemo(() => `${selected.slice(0, 10)}T23:59:59.999Z`, [selected]);

  async function load(): Promise<void> {
    try {
      setError(null);
      const rows = await api.classes(dayStart, dayEnd);
      setClasses(rows.filter((row) => row.status !== 'cancelled'));

      const memberId = currentMemberId();
      if (memberId) {
        const mine = await api.myBookings(memberId);
        setBookings(
          new Set(
            mine
              .filter((b) => b.status === 'booked' || b.status === 'waitlisted')
              .map((b) => b.classId),
          ),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the schedule');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  async function book(klass: ClassSummary): Promise<void> {
    const memberId = currentMemberId();
    if (!memberId) {
      router.push('/sign-in');
      return;
    }
    setBusyId(klass.id);
    setError(null);
    try {
      const result = await api.book(memberId, klass.id);
      setBookings((prev) => new Set(prev).add(klass.id));
      if (result.booking.status === 'waitlisted') {
        setError(null);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Booking failed');
    } finally {
      setBusyId(null);
    }
  }

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
      <Text style={styles.heading}>Schedule</Text>
      <Text style={styles.subheading}>Pick a day, then book a class.</Text>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
        {days.map((day) => {
          const active = day.iso === selected;
          return (
            <TouchableOpacity
              key={day.iso}
              onPress={() => setSelected(day.iso)}
              style={[styles.dayChip, active && styles.dayChipActive]}
            >
              <Text style={[styles.dayChipText, active && styles.dayChipTextActive]}>
                {day.isToday ? 'Today' : day.weekday} {day.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {error ? <View style={styles.error}><Text>{error}</Text></View> : null}

      {loading ? (
        <ActivityIndicator color={theme.accent} style={{ marginTop: 24 }} />
      ) : classes.length === 0 ? (
        <View style={styles.empty}>
          <Text>No classes on this day.</Text>
        </View>
      ) : (
        classes.map((klass) => {
          const isBooked = bookings.has(klass.id);
          const full = klass.spotsLeft <= 0;
          return (
            <View style={styles.card} key={klass.id}>
              <View style={styles.rowBetween}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={styles.title}>{klass.name}</Text>
                  <Text style={styles.meta}>
                    {time(klass.startTime)} · {when(klass.startTime)}
                  </Text>
                  {klass.instructorName ? (
                    <Text style={styles.meta}>with {klass.instructorName}</Text>
                  ) : null}
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text
                    style={[
                      styles.badge,
                      full ? styles.badgeWarn : styles.badgeOk,
                    ]}
                  >
                    {full ? 'Full' : `${klass.spotsLeft} left`}
                  </Text>
                  <Text style={[styles.meta, { marginTop: 4 }]}>
                    {klass.booked}/{klass.capacity}
                  </Text>
                </View>
              </View>

              {klass.waitlisted > 0 ? (
                <Text style={[styles.meta, { marginTop: 6 }]}>
                  {klass.waitlisted} on the waitlist
                </Text>
              ) : null}

              <TouchableOpacity
                style={[
                  isBooked ? styles.buttonGhost : styles.button,
                  { marginTop: 12 },
                  busyId === klass.id && { opacity: 0.6 },
                ]}
                disabled={isBooked || busyId === klass.id}
                onPress={() => book(klass)}
              >
                <Text style={isBooked ? styles.buttonGhostText : styles.buttonText}>
                  {busyId === klass.id
                    ? 'Booking...'
                    : isBooked
                      ? 'Booked'
                      : full
                        ? 'Join waitlist'
                        : 'Book this class'}
                </Text>
              </TouchableOpacity>
            </View>
          );
        })
      )}

      </ScrollView>
  );
}
