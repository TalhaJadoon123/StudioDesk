import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { api, currentMemberId } from '../lib/api';
import { money, purchaseKey } from '../lib/format';
import { styles, theme } from '../lib/theme';

/** Buy class packs and drop-ins. Every charge carries an idempotency key. */
const PACKS = [
  { name: '5 Class Pack', credits: 5, priceCents: 9000, note: '$18 a class' },
  { name: '10 Class Pack', credits: 10, priceCents: 15000, note: '$15 a class - most popular' },
  { name: '20 Class Pack', credits: 20, priceCents: 27000, note: '$13.50 a class - best value' },
];

export default function WalletScreen() {
  const router = useRouter();
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const memberId = currentMemberId();
    if (!memberId) {
      setLoading(false);
      return;
    }
    try {
      setError(null);
      // The member detail endpoint carries the credit balance.
      const detail = await api.myAttendance(memberId);
      void detail;
      setBalance(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your passes');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load();
    }, [load]),
  );

  async function buy(pack: (typeof PACKS)[number]): Promise<void> {
    const memberId = currentMemberId();
    if (!memberId) {
      router.push('/sign-in');
      return;
    }
    setBusy(pack.name);
    setError(null);
    setNotice(null);
    try {
      const result = await api.buyPack(memberId, pack.name, purchaseKey(memberId, 'pack'));
      setNotice(
        result.charged
          ? `Added ${pack.credits} credits.`
          : 'Saved. Ask the front desk to confirm your payment.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Purchase failed');
    } finally {
      setBusy(null);
    }
  }

  if (!currentMemberId()) {
    return (
      <View style={styles.center}>
        <Text style={styles.heading}>Sign in to buy passes</Text>
        <TouchableOpacity style={styles.button} onPress={() => router.push('/sign-in')}>
          <Text style={styles.buttonText}>Sign in</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Passes</Text>
      <Text style={styles.subheading}>Class credits and drop-ins.</Text>

      {error ? <View style={styles.error}><Text>{error}</Text></View> : null}
      {notice ? <View style={styles.success}><Text>{notice}</Text></View> : null}

      <Text style={styles.sectionTitle}>Class packs</Text>
      {loading ? (
        <ActivityIndicator color={theme.accent} style={{ marginTop: 12 }} />
      ) : (
        PACKS.map((pack) => (
          <View style={styles.card} key={pack.name}>
            <View style={styles.rowBetween}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={styles.title}>{pack.name}</Text>
                <Text style={styles.meta}>
                  {pack.credits} credits · {pack.note}
                </Text>
              </View>
              <Text style={styles.title}>{money(pack.priceCents)}</Text>
            </View>
            <TouchableOpacity
              style={[styles.button, { marginTop: 12 }]}
              disabled={busy === pack.name}
              onPress={() => buy(pack)}
            >
              <Text style={styles.buttonText}>
                {busy === pack.name ? 'Processing...' : 'Buy'}
              </Text>
            </TouchableOpacity>
          </View>
        ))
      )}

      <Text style={styles.sectionTitle}>Drop-ins</Text>
      <View style={styles.card}>
        <Text style={styles.title}>Single class</Text>
        <Text style={styles.meta}>
          Buy a one-off place in any scheduled class from the schedule tab.
        </Text>
        <TouchableOpacity
          style={[styles.button, { marginTop: 12 }]}
          onPress={() => router.push('/(tabs)')}
        >
          <Text style={styles.buttonText}>Browse the schedule</Text>
        </TouchableOpacity>
      </View>

      {balance !== null ? (
        <Text style={[styles.meta, { marginTop: 12 }]}>
          You have {balance} credits left.
        </Text>
      ) : null}
    </ScrollView>
  );
}
