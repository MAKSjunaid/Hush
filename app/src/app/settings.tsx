import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Share, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Avatar, Button, Field, Header, Row, Screen, Sheet, T, Toggle, tap } from '@/components/ui';
import { fonts, ThemeMode, useTheme } from '@/lib/theme';
import {
  avatarUrl, changePassword, changeUsername, deleteAccount, disableNotifications, enableNotifications,
  listBlocked, logout, Me, notificationsActive, removeAvatar, setAvatar, unblockUser, updateMe, useStore, User,
} from '@/lib/store';
import * as ImagePicker from 'expo-image-picker';
import {
  biometricAvailable, getBiometricPref, getLockDelay, isLockEnabled, setBiometricPref, setLockDelay, setPin,
} from '@/lib/lock';
import { API_URL, APP_VERSION, isWeb } from '@/lib/config';

const LOCK_DELAYS = [
  { s: 0, label: 'Immediately' },
  { s: 60, label: 'After 1 minute' },
  { s: 300, label: 'After 5 minutes' },
  { s: 3600, label: 'After 1 hour' },
];

export default function Settings() {
  const { c, mode, setMode } = useTheme();
  const router = useRouter();
  const me = useStore((s) => s.me);
  const [sheet, setSheet] = useState<null | 'pin' | 'delay' | 'blocked' | 'delete' | 'profile' | 'password'>(null);
  const [lockOn, setLockOn] = useState(false);
  const [bioOn, setBioOn] = useState(false);
  const [bioAvail, setBioAvail] = useState(false);
  const [delay, setDelay] = useState(0);
  const [notifOn, setNotifOn] = useState(false); // web: reflects real browser permission + subscription

  useEffect(() => {
    (async () => {
      setLockOn(await isLockEnabled());
      setBioOn(await getBiometricPref());
      setBioAvail(await biometricAvailable());
      setDelay(await getLockDelay());
      if (isWeb) setNotifOn(await notificationsActive());
    })();
  }, []);

  if (!me) return null;
  const s = me.settings || {};
  const setPref = (k: keyof typeof s, v: boolean) => updateMe({ settings: { ...s, [k]: v } }).catch(() => {});

  return (
    <Screen>
      <Header title="Privacy & settings" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        <Pressable onPress={() => setSheet('profile')} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 18, backgroundColor: c.surface, borderWidth: c.dark ? 0 : 1, borderColor: c.border }}>
          <View>
            <Avatar name={me.username} size={56} uri={avatarUrl(me)} />
            <View style={{ position: 'absolute', right: -2, bottom: -2, width: 22, height: 22, borderRadius: 11, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: c.surface }}>
              <Ionicons name="camera" size={12} color={c.accentText} />
            </View>
          </View>
          <View style={{ flex: 1 }}>
            <T variant="bodyStrong">{me.displayName}</T>
            <T variant="small">@{me.username}</T>
          </View>
          <Ionicons name="pencil" size={16} color={c.faint} />
        </Pressable>

        <Section title="Appearance">
          <View style={{ flexDirection: 'row', gap: 8, paddingVertical: 8 }} accessibilityRole="radiogroup">
            {(['dark', 'light', 'system'] as ThemeMode[]).map((m) => (
              <Pressable
                key={m}
                accessibilityRole="radio"
                accessibilityState={{ checked: mode === m }}
                onPress={() => {
                  tap();
                  setMode(m);
                }}
                style={{ flex: 1, height: 64, borderRadius: 14, borderWidth: 1.5, borderColor: mode === m ? c.accent : c.border, backgroundColor: mode === m ? c.accentSoft : 'transparent', alignItems: 'center', justifyContent: 'center', gap: 4 }}
              >
                <Ionicons name={m === 'system' ? 'phone-portrait-outline' : m === 'light' ? 'sunny-outline' : 'moon-outline'} size={20} color={mode === m ? c.accentText : c.muted} />
                <T style={{ fontFamily: fonts.medium, fontSize: 13 }} color={mode === m ? c.accentText : c.muted}>{m === 'system' ? 'Automatic' : m === 'light' ? 'Light' : 'Dark'}</T>
              </Pressable>
            ))}
          </View>
        </Section>

        <Section title="Privacy">
          <Toggle label="Show when I'm online" sub="Off: nobody sees when you're active" value={s.showOnline !== false} onChange={(v) => setPref('showOnline', v)} />
          <Toggle label="Show last seen" value={s.showLastSeen !== false} onChange={(v) => setPref('showLastSeen', v)} />
          <Toggle label="Typing indicator" sub="Show when you're typing" value={s.typing !== false} onChange={(v) => setPref('typing', v)} />
          <Toggle label="Findable in search" sub="Off: people need your exact username" value={s.discoverable !== false} onChange={(v) => setPref('discoverable', v)} />
        </Section>

        <Section title="Security">
          <Toggle
            label="App lock"
            sub={isWeb ? '4-digit PIN to open HushChat' : 'PIN, Face ID or fingerprint to open HushChat'}
            value={lockOn}
            onChange={async (v) => {
              if (v) setSheet('pin');
              else {
                await setPin(null);
                setLockOn(false);
              }
            }}
          />
          {lockOn && bioAvail ? (
            <Toggle label="Unlock with Face ID / fingerprint" value={bioOn} onChange={async (v) => { await setBiometricPref(v); setBioOn(v); }} />
          ) : null}
          {lockOn ? <Row label="Lock again" value={LOCK_DELAYS.find((d) => d.s === delay)?.label} onPress={() => setSheet('delay')} /> : null}
          <Row icon="key-outline" label="Change password" onPress={() => setSheet('password')} />
          <Row label="Blocked people" onPress={() => setSheet('blocked')} />
        </Section>

        <Section title="Notifications">
          <Toggle
            label="Message notifications"
            sub={'Only ever says "New message" — never the text'}
            value={isWeb ? notifOn : s.notifications !== false}
            onChange={async (v) => {
              // On web/PWA, turning this on is the user tap the browser needs to grant permission +
              // subscribe. Reflect the REAL outcome: if permission is denied, the toggle stays off.
              if (isWeb) {
                if (v) {
                  const ok = await enableNotifications();
                  setNotifOn(ok);
                  setPref('notifications', ok);
                } else {
                  await disableNotifications();
                  setNotifOn(false);
                  setPref('notifications', false);
                }
              } else {
                setPref('notifications', v);
              }
            }}
          />
        </Section>

        <Section title="HushChat">
          <Row
            icon="share-outline"
            label="Invite friends"
            sub="One link for Android, iPhone and browser"
            onPress={() => Share.share({ message: `Chat with me on HushChat — messages vanish once seen. My username: @${me.username}\n${API_URL}/get` })}
          />
          <Row icon="information-circle-outline" label="Version" value={APP_VERSION} />
          <Row icon="log-out-outline" label="Log out" onPress={async () => { await logout(); router.replace('/welcome'); }} />
          <Row icon="trash-outline" label="Delete account and all data" danger onPress={() => setSheet('delete')} />
        </Section>
      </ScrollView>

      <PinSheet visible={sheet === 'pin'} onClose={() => setSheet(null)} onDone={() => { setLockOn(true); setSheet(null); }} />
      <Sheet visible={sheet === 'delay'} onClose={() => setSheet(null)} title="Lock again">
        {LOCK_DELAYS.map((d) => (
          <Pressable key={d.s} accessibilityRole="radio" accessibilityState={{ checked: delay === d.s }} onPress={async () => { await setLockDelay(d.s); setDelay(d.s); setSheet(null); }} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 50 }}>
            <T>{d.label}</T>
            {delay === d.s ? <Ionicons name="checkmark" size={20} color={c.accent} /> : null}
          </Pressable>
        ))}
      </Sheet>
      <BlockedSheet visible={sheet === 'blocked'} onClose={() => setSheet(null)} />
      <ProfileSheet visible={sheet === 'profile'} onClose={() => setSheet(null)} me={me} />
      <PasswordSheet visible={sheet === 'password'} onClose={() => setSheet(null)} />
      <DeleteSheet visible={sheet === 'delete'} onClose={() => setSheet(null)} onDeleted={() => router.replace('/welcome')} />
    </Screen>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 18 }}>
      <T variant="caption" style={{ marginBottom: 2 }}>{title}</T>
      {children}
    </View>
  );
}

function PinSheet({ visible, onClose, onDone }: { visible: boolean; onClose: () => void; onDone: () => void }) {
  const { c } = useTheme();
  const [pin, setPinText] = useState('');
  const [confirm, setConfirm] = useState('');
  useEffect(() => {
    if (visible) {
      setPinText('');
      setConfirm('');
    }
  }, [visible]);
  const valid = /^\d{4}$/.test(pin) && pin === confirm;
  const box = (value: string, onChange: (v: string) => void, label: string) => (
    <View style={{ gap: 6 }}>
      <T variant="label">{label}</T>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={(t) => onChange(t.replace(/\D/g, '').slice(0, 4))}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={4}
        style={{ height: 56, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg, color: c.text, fontSize: 24, letterSpacing: 16, textAlign: 'center', fontFamily: fonts.semibold }}
      />
    </View>
  );
  return (
    <Sheet visible={visible} onClose={onClose} title="Choose a 4-digit PIN">
      <View style={{ gap: 14 }}>
        {box(pin, setPinText, 'PIN')}
        {box(confirm, setConfirm, 'Type it again')}
        {confirm.length === 4 && pin !== confirm ? <T variant="small" color={c.danger}>PINs don't match</T> : null}
        <Button title="Turn on app lock" disabled={!valid} onPress={async () => { await setPin(pin); onDone(); }} />
      </View>
    </Sheet>
  );
}

function BlockedSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [users, setUsers] = useState<User[] | null>(null);
  useEffect(() => {
    if (visible) listBlocked().then(setUsers).catch(() => setUsers([]));
  }, [visible]);
  return (
    <Sheet visible={visible} onClose={onClose} title="Blocked people">
      {users === null ? <T variant="small">Loading…</T> : users.length === 0 ? <T variant="small">You haven't blocked anyone.</T> : null}
      {users?.map((u) => (
        <View key={u.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 }}>
          <Avatar name={u.username} size={40} uri={avatarUrl(u)} />
          <T style={{ flex: 1 }}>@{u.username}</T>
          <Button small variant="secondary" title="Unblock" onPress={async () => { await unblockUser(u.id); setUsers((x) => x?.filter((y) => y.id !== u.id) ?? null); }} />
        </View>
      ))}
    </Sheet>
  );
}

function ProfileSheet({ visible, onClose, me }: { visible: boolean; onClose: () => void; me: Me }) {
  const { c } = useTheme();
  const [name, setName] = useState(me.displayName);
  const [username, setUsername] = useState(me.username);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  useEffect(() => {
    if (visible) {
      setName(me.displayName);
      setUsername(me.username);
      setError(null);
    }
  }, [visible, me.displayName, me.username]);

  const cleanUser = username.trim().replace(/^@/, '').toLowerCase();
  const nameChanged = name.trim() && name.trim() !== me.displayName;
  const userChanged = cleanUser && cleanUser !== me.username.toLowerCase();
  const canSave = !!(nameChanged || userChanged) && !busy;

  const pickPhoto = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [1, 1], quality: 1,
      });
      if (res.canceled || !res.assets?.[0]) return;
      setPhotoBusy(true);
      setError(null);
      await setAvatar(res.assets[0].uri);
    } catch (e: any) {
      setError(e.message || 'Could not update photo');
    } finally {
      setPhotoBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (userChanged) await changeUsername(cleanUser); // contacts & chats stay — connections key on your id
      if (nameChanged) await updateMe({ displayName: name.trim() });
      onClose();
    } catch (e: any) {
      setError(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Edit profile">
      <View style={{ gap: 16 }}>
        <View style={{ alignItems: 'center', gap: 10 }}>
          <Pressable onPress={pickPhoto} disabled={photoBusy} style={{ opacity: photoBusy ? 0.6 : 1 }}>
            <Avatar name={me.username} size={88} uri={avatarUrl(me)} />
            <View style={{ position: 'absolute', right: -2, bottom: -2, width: 30, height: 30, borderRadius: 15, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: c.surface }}>
              <Ionicons name="camera" size={16} color={c.accentText} />
            </View>
          </Pressable>
          <View style={{ flexDirection: 'row', gap: 16 }}>
            <Pressable onPress={pickPhoto} disabled={photoBusy}><T variant="small" color={c.accent}>{me.avatarAt ? 'Change photo' : 'Add photo'}</T></Pressable>
            {me.avatarAt ? (
              <Pressable onPress={async () => { setPhotoBusy(true); try { await removeAvatar(); } catch { } finally { setPhotoBusy(false); } }} disabled={photoBusy}>
                <T variant="small" color={c.danger}>Remove</T>
              </Pressable>
            ) : null}
          </View>
        </View>

        <View style={{ gap: 6 }}>
          <T variant="label">Name</T>
          <Field value={name} onChangeText={setName} maxLength={40} placeholder="Your name" />
        </View>

        <View style={{ gap: 6 }}>
          <T variant="label">Username</T>
          <Field value={username} onChangeText={(t) => setUsername(t.replace(/\s/g, ''))} maxLength={24} autoCapitalize="none" placeholder="username" />
          <T variant="small" color={c.faint}>Changing it keeps all your chats and contacts. You can change it once every 30 days.</T>
        </View>

        {error ? <T variant="small" color={c.danger}>{error}</T> : null}
        <Button title="Save" loading={busy} disabled={!canSave} onPress={save} />
      </View>
    </Sheet>
  );
}

function PasswordSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { c } = useTheme();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (visible) { setCurrent(''); setNext(''); setConfirm(''); setError(null); setDone(false); }
  }, [visible]);

  const valid = current.length >= 1 && next.length >= 8 && next === confirm;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      setDone(true);
      setTimeout(onClose, 1100);
    } catch (e: any) {
      setError(e.message || 'Could not change password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Change password">
      <View style={{ gap: 14 }}>
        {done ? (
          <T color={c.success}>Password changed. You're still logged in on this device.</T>
        ) : (
          <>
            <Field label="Current password" value={current} onChangeText={setCurrent} secureTextEntry autoCapitalize="none" />
            <Field label="New password" value={next} onChangeText={setNext} secureTextEntry autoCapitalize="none" />
            <Field label="Repeat new password" value={confirm} onChangeText={setConfirm} secureTextEntry autoCapitalize="none"
              error={confirm.length > 0 && next !== confirm ? "Passwords don't match" : error} />
            <T variant="small" color={c.faint}>At least 8 characters.</T>
            <Button title="Update password" loading={busy} disabled={!valid} onPress={save} />
          </>
        )}
      </View>
    </Sheet>
  );
}

function DeleteSheet({ visible, onClose, onDeleted }: { visible: boolean; onClose: () => void; onDeleted: () => void }) {
  const { c } = useTheme();
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (visible) {
      setPw('');
      setError(null);
    }
  }, [visible]);
  return (
    <Sheet visible={visible} onClose={onClose} title="Delete your account?">
      <View style={{ gap: 14 }}>
        <T variant="small">This permanently deletes your account, contacts and every message waiting on the server. It can't be undone.</T>
        <Field label="Password" value={pw} onChangeText={setPw} secureTextEntry autoCapitalize="none" error={error} />
        <Button
          title="Delete everything"
          variant="danger"
          loading={busy}
          disabled={!pw}
          onPress={async () => {
            setBusy(true);
            try {
              await deleteAccount(pw);
              onDeleted();
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        />
        <T variant="small" color={c.faint} style={{ textAlign: 'center' }}>Your username becomes available to others again.</T>
      </View>
    </Sheet>
  );
}
