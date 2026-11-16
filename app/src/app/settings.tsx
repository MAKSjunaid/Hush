import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Share, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Avatar, Button, Field, Header, Row, Screen, Sheet, T, Toggle, tap } from '@/components/ui';
import { fonts, ThemeMode, useTheme } from '@/lib/theme';
import { deleteAccount, listBlocked, logout, unblockUser, updateMe, useStore, User } from '@/lib/store';
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
  const [sheet, setSheet] = useState<null | 'pin' | 'delay' | 'blocked' | 'delete' | 'name'>(null);
  const [lockOn, setLockOn] = useState(false);
  const [bioOn, setBioOn] = useState(false);
  const [bioAvail, setBioAvail] = useState(false);
  const [delay, setDelay] = useState(0);

  useEffect(() => {
    (async () => {
      setLockOn(await isLockEnabled());
      setBioOn(await getBiometricPref());
      setBioAvail(await biometricAvailable());
      setDelay(await getLockDelay());
    })();
  }, []);

  if (!me) return null;
  const s = me.settings || {};
  const setPref = (k: keyof typeof s, v: boolean) => updateMe({ settings: { ...s, [k]: v } }).catch(() => {});

  return (
    <Screen>
      <Header title="Privacy & settings" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        <Pressable onPress={() => setSheet('name')} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 18, backgroundColor: c.surface, borderWidth: c.dark ? 0 : 1, borderColor: c.border }}>
          <Avatar name={me.username} size={56} />
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
            sub={isWeb ? '4-digit PIN to open Hush' : 'PIN, Face ID or fingerprint to open Hush'}
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
          <Row label="Blocked people" onPress={() => setSheet('blocked')} />
        </Section>

        <Section title="Notifications">
          <Toggle label="Message notifications" sub={'Only ever says "New message" — never the text'} value={s.notifications !== false} onChange={(v) => setPref('notifications', v)} />
        </Section>

        <Section title="Hush">
          <Row
            icon="share-outline"
            label="Invite friends"
            sub="One link for Android, iPhone and browser"
            onPress={() => Share.share({ message: `Chat with me on Hush — messages vanish once seen. My username: @${me.username}\n${API_URL}/get` })}
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
      <NameSheet visible={sheet === 'name'} onClose={() => setSheet(null)} current={me.displayName} />
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
          <Avatar name={u.username} size={40} />
          <T style={{ flex: 1 }}>@{u.username}</T>
          <Button small variant="secondary" title="Unblock" onPress={async () => { await unblockUser(u.id); setUsers((x) => x?.filter((y) => y.id !== u.id) ?? null); }} />
        </View>
      ))}
    </Sheet>
  );
}

function NameSheet({ visible, onClose, current }: { visible: boolean; onClose: () => void; current: string }) {
  const [name, setName] = useState(current);
  useEffect(() => {
    if (visible) setName(current);
  }, [visible, current]);
  return (
    <Sheet visible={visible} onClose={onClose} title="Display name">
      <View style={{ gap: 14 }}>
        <Field value={name} onChangeText={setName} maxLength={40} placeholder="Your name" />
        <Button title="Save" disabled={!name.trim()} onPress={async () => { await updateMe({ displayName: name.trim() }); onClose(); }} />
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
