import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import * as Notifications from "expo-notifications";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  Dimensions,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from "react-native";
import { BarChart } from "react-native-chart-kit";

const STORAGE_KEY = "pomodoro_history_v1";
const SCREEN_WIDTH = Dimensions.get("window").width;

// Component nhỏ để chỉ giữ màn hình sáng khi đang chạy
function KeepAwakeWhileRunning() {
  useKeepAwake();
  return null;
}

// Cấu hình cách hiển thị notification khi app foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function App() {
  const [mode, setMode] = useState("work"); // "work" | "break"
  const [isRunning, setIsRunning] = useState(false);
  const [workMinutes, setWorkMinutes] = useState(25);
  const [breakMinutes, setBreakMinutes] = useState(5);
  const [secondsLeft, setSecondsLeft] = useState(25 * 60);
  const [endAt, setEndAt] = useState(null); // timestamp ms khi phiên sẽ kết thúc
  const [history, setHistory] = useState([]); // {mode, durationSec, endedAtISO, dayKey}
  const intervalRef = useRef(null);
  const appState = useRef(AppState.currentState);

  // Xin quyền và setup channel Android
  useEffect(() => {
    (async () => {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Thiếu quyền",
          "Không có quyền gửi thông báo. Vào Settings bật Notifications."
        );
      }
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync("pomodoro", {
          name: "Pomodoro",
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          sound: "default",
          lockscreenVisibility:
            Notifications.AndroidNotificationVisibility.PUBLIC,
        });
      }
    })();
  }, []);

  // Load lịch sử
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) setHistory(JSON.parse(raw));
      } catch {}
    })();
  }, []);

  // Lưu lịch sử khi thay đổi
  useEffect(() => {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(history)).catch(() => {});
  }, [history]);

  // Đồng bộ khi app back/foreground để tránh lệch timer
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (appState.current.match(/inactive|background/) && next === "active") {
        // khi quay lại app, cập nhật secondsLeft dựa trên endAt
        if (isRunning && endAt) {
          const diff = Math.max(0, Math.round((endAt - Date.now()) / 1000));
          setSecondsLeft(diff);
          if (diff === 0) onComplete(); // trễ mà vừa khít
        }
      }
      appState.current = next;
    });
    return () => sub.remove();
  }, [isRunning, endAt]);

  // Reset seconds khi đổi mode
  useEffect(() => {
    if (!isRunning) {
      setSecondsLeft((mode === "work" ? workMinutes : breakMinutes) * 60);
    }
  }, [mode, workMinutes, breakMinutes, isRunning]);

  const scheduleEndNotification = async (sec) => {
    try {
      await Notifications.cancelAllScheduledNotificationsAsync();
      await Notifications.scheduleNotificationAsync({
        content: {
          title: mode === "work" ? "Hết phiên làm việc" : "Hết giờ nghỉ",
          body:
            mode === "work"
              ? "Đứng lên thả lỏng 1 chút rồi quay lại."
              : "Quay lại công việc thôi.",
          sound: "default",
        },
        trigger: {
          seconds: sec,
          channelId: Platform.OS === "android" ? "pomodoro" : undefined,
        },
      });
    } catch (e) {}
  };

  const clearTimer = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const start = async () => {
    if (isRunning) return;
    const sec = secondsLeft;
    if (sec <= 0) return;
    setIsRunning(true);
    const end = Date.now() + sec * 1000;
    setEndAt(end);
    await scheduleEndNotification(sec);

    clearTimer();
    intervalRef.current = setInterval(() => {
      const remain = Math.max(0, Math.round((end - Date.now()) / 1000));
      setSecondsLeft(remain);
      if (remain === 0) {
        clearTimer();
        onComplete();
      }
    }, 250);
  };

  const pause = async () => {
    if (!isRunning) return;
    setIsRunning(false);
    clearTimer();
    await Notifications.cancelAllScheduledNotificationsAsync();
    // secondsLeft đã được cập nhật theo endAt rồi
    setEndAt(null);
  };

  const reset = async () => {
    await Notifications.cancelAllScheduledNotificationsAsync();
    setIsRunning(false);
    clearTimer();
    setEndAt(null);
    setSecondsLeft((mode === "work" ? workMinutes : breakMinutes) * 60);
  };

  const switchMode = async () => {
    await reset();
    setMode((m) => (m === "work" ? "break" : "work"));
  };

  const onComplete = async () => {
    try {
      await Notifications.cancelAllScheduledNotificationsAsync();
    } catch {}
    setIsRunning(false);
    clearTimer();
    setEndAt(null);
    setSecondsLeft(0);

    // Haptics vui vẻ một chút cho đỡ buồn đời
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
      () => {}
    );

    // Ghi lịch sử
    const endedAtISO = new Date().toISOString();
    const dayKey = endedAtISO.slice(0, 10); // YYYY-MM-DD
    const durationSec = (mode === "work" ? workMinutes : breakMinutes) * 60;
    const item = {
      mode,
      durationSec,
      endedAtISO,
      dayKey,
      id: endedAtISO + "_" + mode,
    };
    setHistory((prev) => [item, ...prev].slice(0, 300)); // giữ gọn
    // Auto-switch
    const nextMode = mode === "work" ? "break" : "work";
    setMode(nextMode);
    setSecondsLeft((nextMode === "work" ? workMinutes : breakMinutes) * 60);
  };

  const minutesStr = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const secondsStr = String(secondsLeft % 60).padStart(2, "0");

  // Tùy chỉnh nhanh thời gian: 15/25/50 cho work, 5/10/15 cho break
  const presetWork = [15, 25, 50];
  const presetBreak = [5, 10, 15];

  const applyPreset = (m) => {
    if (isRunning) return;
    if (mode === "work") {
      setWorkMinutes(m);
      setSecondsLeft(m * 60);
    } else {
      setBreakMinutes(m);
      setSecondsLeft(m * 60);
    }
  };

  // Dữ liệu chart: số phiên hoàn thành theo ngày (7 ngày gần nhất)
  const last7 = useMemo(() => {
    const map = new Map(); // dayKey -> count
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      map.set(key, 0);
    }
    for (const h of history) {
      if (map.has(h.dayKey)) map.set(h.dayKey, map.get(h.dayKey) + 1);
    }
    const labels = Array.from(map.keys()).map((k) => k.slice(5)); // MM-DD
    const data = Array.from(map.values());
    return { labels, data };
  }, [history]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {isRunning ? <KeepAwakeWhileRunning /> : null}

      <Text style={styles.title}>Task Timer (Pomodoro)</Text>
      <Text style={styles.mode}>{mode === "work" ? "Work" : "Break"}</Text>

      <Text style={styles.timer}>
        {minutesStr}:{secondsStr}
      </Text>

      <View style={styles.btnRow}>
        {!isRunning ? (
          <TouchableOpacity
            style={[styles.btn, styles.primary]}
            onPress={start}
          >
            <Text style={styles.btnText}>Start</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[styles.btn, styles.warn]} onPress={pause}>
            <Text style={styles.btnText}>Pause</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={[styles.btn, styles.gray]} onPress={reset}>
          <Text style={styles.btnText}>Reset</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, styles.switch]}
          onPress={switchMode}
        >
          <Text style={styles.btnText}>Switch</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.presetGroup}>
        <Text style={styles.sectionTitle}>Tùy chỉnh nhanh</Text>
        <View style={styles.presetRow}>
          {(mode === "work" ? presetWork : presetBreak).map((m) => (
            <TouchableOpacity
              key={m}
              style={styles.preset}
              onPress={() => applyPreset(m)}
            >
              <Text style={styles.presetText}>{m}’</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.hint}>
          {mode === "work"
            ? `Work mặc định: ${workMinutes}’`
            : `Break mặc định: ${breakMinutes}’`}
        </Text>
      </View>

      <Text style={styles.sectionTitle}>Biểu đồ số phiên / ngày (7 ngày)</Text>
      <BarChart
        data={{
          labels: last7.labels,
          datasets: [{ data: last7.data }],
        }}
        width={SCREEN_WIDTH - 24}
        height={200}
        fromZero
        chartConfig={{
          backgroundColor: "#ffffff",
          backgroundGradientFrom: "#ffffff",
          backgroundGradientTo: "#ffffff",
          decimalPlaces: 0,
          color: (opacity = 1) => `rgba(20, 20, 20, ${opacity})`,
          labelColor: (opacity = 1) => `rgba(20, 20, 20, ${opacity})`,
          propsForBackgroundLines: { strokeDasharray: "" },
        }}
        style={{ borderRadius: 12, marginVertical: 8 }}
      />

      <Text style={styles.sectionTitle}>Lịch sử gần đây</Text>
      {history.slice(0, 10).map((h) => (
        <View key={h.id} style={styles.historyItem}>
          <Text style={styles.historyText}>
            [{h.dayKey}] {h.mode.toUpperCase()} •{" "}
            {Math.round(h.durationSec / 60)}’
          </Text>
        </View>
      ))}

      <Text style={styles.footerNote}>
        Lưu ý: App vẫn gửi thông báo khi bạn đưa app ra nền nhờ local
        notification đã schedule. Khi quay lại app, timer tự đồng bộ theo thời
        điểm kết thúc đã đặt.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, paddingBottom: 24, alignItems: "center" },
  title: { fontSize: 22, fontWeight: "700", marginTop: 8 },
  mode: { fontSize: 16, marginTop: 6, opacity: 0.8 },
  timer: {
    fontSize: 56,
    fontWeight: "800",
    marginVertical: 16,
    letterSpacing: 2,
  },
  btnRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  btn: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10 },
  btnText: { color: "#fff", fontWeight: "700" },
  primary: { backgroundColor: "#2563eb" },
  warn: { backgroundColor: "#ea580c" },
  gray: { backgroundColor: "#6b7280" },
  switch: { backgroundColor: "#16a34a" },
  presetGroup: { width: "100%", marginTop: 8 },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginTop: 12,
    marginBottom: 6,
  },
  presetRow: { flexDirection: "row", gap: 8 },
  preset: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "#e5e7eb",
    borderRadius: 10,
  },
  presetText: { fontWeight: "700" },
  hint: { marginTop: 6, opacity: 0.8 },
  historyItem: {
    width: "100%",
    padding: 8,
    backgroundColor: "#f3f4f6",
    borderRadius: 8,
    marginVertical: 3,
  },
  historyText: { fontSize: 14 },
  footerNote: {
    fontSize: 12,
    opacity: 0.7,
    marginTop: 12,
    textAlign: "center",
  },
});
