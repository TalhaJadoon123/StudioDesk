import { useState } from 'react';
import { ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { signIn } from '../lib/api';
import { styles } from '../lib/theme';

/**
 * Sign-in.
 *
 * Auth.js issues the session on the web; the mobile app stores the resulting
 * token locally. Swap `signIn` for your Auth.js credentials endpoint if you
 * front it differently.
 */
export default function SignInScreen() {
  const router = useRouter();
  const [memberId, setMemberId] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (!memberId.trim() || !token.trim()) {
      setError('Enter both your member ID and your access token.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn(token.trim(), memberId.trim());
      router.replace('/(tabs)');
    } catch {
      setError('Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Sign in</Text>
      <Text style={styles.subheading}>
        Use the member ID your studio has on file.
      </Text>

      {error ? <View style={styles.error}><Text>{error}</Text></View> : null}

      <Text style={styles.label}>Member ID</Text>
      <TextInput
        style={[styles.input, { marginBottom: 14 }]}
        value={memberId}
        onChangeText={setMemberId}
        placeholder="mem_..."
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.label}>Access token</Text>
      <TextInput
        style={[styles.input, { marginBottom: 20 }]}
        value={token}
        onChangeText={setToken}
        placeholder="Issued by your studio"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />

      <TouchableOpacity style={styles.button} onPress={submit} disabled={busy}>
        <Text style={styles.buttonText}>{busy ? 'Signing in...' : 'Sign in'}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}
