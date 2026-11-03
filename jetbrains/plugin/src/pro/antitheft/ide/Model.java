package pro.antitheft.ide;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * What the tool window shows, from antitheft's answer (`GET /api/v1/ide/events`): the guard's events in this IDE
 * and antitheft's alerts whose chain runs through it. The same words as the VS Code extension and the antitheft
 * app: "who tried to read your what", then what happened. No detection internals.
 */
final class Model {
    private Model() {}

    enum Tone { CRITICAL, WARNING, INFO, QUIET }

    /** `severity` is the app's (critical, warning, blocked), `target` what it was about, `actorLine` who did it as the app's
     *  actor line ("Claude Code › rm"). */
    record Item(String key, long at, Tone tone, String label, String title, String detail, String pluginId, String pluginName,
                String vaultId, String programImage, String programTitle, List<String> chain, Long alertId, boolean needsYou,
                String severity, String target, String actorLine) {
        Item(String key, long at, Tone tone, String label, String title, String detail, String pluginId, String pluginName,
             String vaultId, String programImage, String programTitle, List<String> chain, Long alertId, boolean needsYou) {
            this(key, at, tone, label, title, detail, pluginId, pluginName, vaultId, programImage, programTitle, chain, alertId, needsYou, null, null, pluginName);
        }

        Item reviewed() {
            return new Item(key, at, tone, label, title, detail, pluginId, pluginName, vaultId, programImage, programTitle, chain, alertId, false, severity, target, actorLine);
        }

        Item withTitle(String t) {
            return new Item(key, at, tone, label, t, detail, pluginId, pluginName, vaultId, programImage, programTitle, chain, alertId, needsYou, severity, target, actorLine);
        }

        /** The app's severity: given, else from the label (a block is "blocked", the good outcome). */
        String sev() {
            if (severity != null) return severity;
            if (label.equals("BLOCKED") || label.equals("STOPPED")) return "blocked";
            if (label.equals("WOULD BE BLOCKED") || label.equals("HELD")) return "warning";
            return tone == Tone.CRITICAL ? "critical" : tone == Tone.WARNING ? "warning" : null;
        }
    }

    static final Map<String, String> SEVERITY_LABEL = Map.of("critical", "Critical", "warning", "Warning", "blocked", "Blocked");

    private static final Map<String, String> CATEGORY_WORDS = Map.ofEntries(
        Map.entry("passwords", "saved passwords"), Map.entry("cookies", "cookies"), Map.entry("wallet", "wallet"),
        Map.entry("keys", "keys"), Map.entry("ssh_key", "SSH key"), Map.entry("ssh_material", "SSH keys"),
        Map.entry("totp", "2FA codes"), Map.entry("otp", "2FA codes"), Map.entry("messages", "messages"),
        Map.entry("keychain", "keychain"), Map.entry("credentials", "credentials"), Map.entry("dev_credential", "credentials"));

    static String vaultPhrase(String name, String category) {
        String c = category == null ? "" : category.toLowerCase();
        String word = CATEGORY_WORDS.getOrDefault(c, c.contains("wallet") ? "wallet" : c.contains("password") ? "saved passwords" : c.contains("ssh") ? "SSH keys" : "");
        if (word.isEmpty() || name.toLowerCase().endsWith(word.toLowerCase())) return "your " + name;
        return "your " + name + " " + word;
    }

    /** The program a command line starts: its first word, read with quotes ("C:\Program Files\x.exe" stays whole). */
    static String programOf(String command) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^\"((?:[^\"\\\\]|\\\\.)*)\"|^'([^']*)'|^(\\S+)").matcher(command.trim());
        if (!m.find()) return "";
        String first = m.group(1) != null ? m.group(1) : m.group(2) != null ? m.group(2) : m.group(3);
        return basename(first.replace("\\\"", "\""));
    }

    static String basename(String p) {
        String[] parts = p.split("[\\\\/]");
        for (int i = parts.length - 1; i >= 0; i--) if (!parts[i].isEmpty()) return parts[i];
        return p;
    }

    private static String str(JsonObject o, String k) {
        JsonElement e = o == null ? null : o.get(k);
        return e == null || e.isJsonNull() ? null : e.getAsString();
    }

    static String pluginLabel(String id, Function<String, String> names) {
        if (id == null || id.equals("unknown")) return "An unknown plugin";
        String n = names.apply(id);
        return n != null ? n : id;
    }

    static Item event(JsonObject e, Function<String, String> names) {
        String kind = str(e, "kind");
        long at = e.get("at").getAsLong();
        String key = "event-" + e.get("seq").getAsLong();
        String id = str(e, "extension_id");
        String who = pluginLabel(id, names);
        switch (kind == null ? "" : kind) {
            case "blocked": {
                JsonObject v = e.has("vault") && e.get("vault").isJsonObject() ? e.getAsJsonObject("vault") : null;
                String what = v != null ? vaultPhrase(str(v, "name"), str(v, "category")) : "a protected file";
                return new Item(key, at, Tone.CRITICAL, "BLOCKED", who + " tried to read " + what,
                    "", id, who, v != null ? str(v, "id") : null, null, null, List.of(), null, true, "blocked", v != null ? str(v, "name") : "", who);
            }
            case "spawn": {
                String cmd = str(e, "command");
                String name = cmd == null || programOf(cmd).isEmpty() ? "a program" : programOf(cmd);
                return new Item(key, at, Tone.QUIET, "STARTED", who + " started " + name, cmd == null ? "" : cmd, id, who, null, null, null, List.of(), null, false);
            }
            case "write": {
                String p = str(e, "path");
                return new Item(key, at, Tone.QUIET, "WROTE", who + " wrote a program: " + (p == null ? "?" : basename(p)), p == null ? "" : p, id, who, null, null, null, List.of(), null, false);
            }
            // the guard's own health is not something a plugin did: the standing's "IDE guard: partly" says it
            case "guard_partial", "guard_lost":
                return null;
            default:
                return null;
        }
    }

    private static final java.util.Set<String> PASSTHROUGH = java.util.Set.of("sudo", "doas", "timeout", "env", "nohup", "setsid", "xargs", "nice", "ionice", "stdbuf", "systemd", "init");

    private static String nameOf(JsonObject p) {
        String app = str(p, "app"), image = str(p, "image_path");
        return app != null ? app : image != null ? basename(image) : "?";
    }

    /** The app's actor line: the first launcher above the actor that is not a shell, init or a pass-through, then the actor. */
    static String actorLine(JsonArray chain, String actor) {
        if (chain != null) for (JsonElement e : chain) {
            if (!e.isJsonObject()) continue;
            JsonObject p = e.getAsJsonObject();
            String name = nameOf(p), role = str(p, "role");
            if ("shell".equals(role) || "init".equals(role) || name.equals(actor) || PASSTHROUGH.contains(name.toLowerCase())) continue;
            if (name.matches("(?i)(ba|da|z|fi|k|tc|c)?sh")) continue;
            return ("terminal".equals(role) ? "Terminal" : name) + " › " + actor;
        }
        return actor;
    }

    private static String humanize(String t) {
        String s = t == null ? "" : t.replace('_', ' ');
        return s.isEmpty() ? s : Character.toUpperCase(s.charAt(0)) + s.substring(1);
    }

    private static final Map<Integer, String> SIGNAL_VERBS = Map.of(2, "interrupt", 9, "kill", 15, "terminate", 18, "resume", 19, "pause");

    /** {title, target, severity} for the kinds that are not a vault read: the app's sentences (`alertTitles.ts`). */
    static String[] otherTitle(String kind, JsonObject d, String actor, boolean paused) {
        java.util.function.Function<String, String> text = k -> str(d, k) == null ? "" : str(d, k);
        java.util.function.Function<String, String> file = k -> text.apply(k).isEmpty() ? "" : basename(text.apply(k));
        java.util.function.BiFunction<String, Boolean, String[]> tried = (phrase, blocked) -> new String[] {
            actor + " tried to " + phrase + " - " + (blocked ? (paused ? "would be blocked" : "blocked") : "allowed"), "", blocked && !paused ? "blocked" : "warning" };
        switch (kind) {
            case "persistence_location_changed": {
                String change = text.apply("change"), f = file.apply("path");
                boolean named = d.has("writer") && d.get("writer").isJsonObject() && str(d.getAsJsonObject("writer"), "image_path") != null;
                String title = named
                    ? actor + " " + ("appeared".equals(change) ? "added" : "disappeared".equals(change) ? "removed" : "changed") + " auto-start entry " + f
                    : "appeared".equals(change) ? "New auto-start entry " + f : "disappeared".equals(change) ? "Auto-start entry " + f + " removed" : "Auto-start entry " + f + " changed";
                return new String[] {title, f, "warning"};
            }
            case "persistence_denied": {
                String[] t = tried.apply("add " + humanize(text.apply("location_id")).toLowerCase(), d.has("denied") && d.get("denied").getAsBoolean());
                t[1] = file.apply("path");
                return t;
            }
            case "signal_delivery": {
                int sig = d.has("signal") ? d.get("signal").getAsInt() : 0;
                String target = file.apply("target_image_path").isEmpty() ? "a protected app" : file.apply("target_image_path");
                String verb = SIGNAL_VERBS.get(sig);
                return tried.apply(verb != null ? verb + " " + target : "send signal " + sig + " to " + target, d.has("blocked") && d.get("blocked").getAsBoolean());
            }
            case "ptrace_blocked":
                return tried.apply(d.has("attach") && d.get("attach").getAsBoolean() ? "debug a protected app" : "read a protected app's memory", true);
            case "self_exec_denied":
                return tried.apply("run code from memory", true);
            case "rename_denied":
                return tried.apply("replace " + file.apply("resource_path"), true);
            case "secret_broker_connect":
                return tried.apply("reach " + (text.apply("broker_name").isEmpty() ? "the password service" : text.apply("broker_name")), false);
            case "resource_change":
                if ("approved_tainted_owner".equals(text.apply("outcome"))) return new String[] {actor + " changed " + file.apply("resource_path") + " - tampered app", file.apply("resource_path"), "critical"};
                if (text.apply("outcome").startsWith("held")) return new String[] {actor + " tried to change " + file.apply("resource_path") + " - held", file.apply("resource_path"), "blocked"};
                return tried.apply("change " + file.apply("resource_path"), false);
            case "owner_change": {
                boolean held = text.apply("outcome").startsWith("held");
                return new String[] {held ? actor + " tried to change " + file.apply("owner_path") + " - held" : actor + " changed " + file.apply("owner_path") + " - allowed", file.apply("owner_path"), held ? "blocked" : "warning"};
            }
            case "revocation": {
                String reason = text.apply("reason");
                boolean killed = reason.endsWith("_killed");
                String why = humanize(killed ? reason.substring(0, reason.length() - 7) : reason).toLowerCase();
                boolean flagged = d.has("enforced") && !d.get("enforced").getAsBoolean();
                return new String[] {killed ? actor + " was ended because " + why : flagged ? actor + " was flagged because " + why : actor + (paused ? " would have lost" : " lost") + " its vault access because " + why, "", flagged ? "critical" : "blocked"};
            }
            case "package_source_changed":
                return new String[] {"Package source " + file.apply("path") + " changed", file.apply("path"), "warning"};
            case "app_image_validation": {
                String app = text.apply("app_name");
                boolean change = d.has("is_change") && d.get("is_change").getAsBoolean();
                return new String[] {!app.isEmpty() ? (change ? app + " changed since you trusted it" : app + " wants to run") : change ? "AppImage changed unexpectedly" : "New AppImage recorded", file.apply("path"), change ? "critical" : "warning"};
            }
            case "unverified_library":
                return new String[] {"Unverified library loaded into a protected app", file.apply("module_path"), "critical"};
            default:
                return new String[] {humanize(kind), "", "warning"};
        }
    }

    static Item alert(JsonObject a, Function<String, String> names, String ide) {
        JsonObject d = a.has("data") && a.get("data").isJsonObject() ? a.getAsJsonObject("data") : new JsonObject();
        JsonObject actor = d.has("actor_process") && d.get("actor_process").isJsonObject() ? d.getAsJsonObject("actor_process")
            : d.has("writer") && d.get("writer").isJsonObject() ? d.getAsJsonObject("writer") : null;
        String image = actor != null ? str(actor, "image_path") : null;
        for (String k : new String[] {"process_image_path", "image_path", "sender_image_path", "tracer_image_path", "actor_image_path"}) if (image == null) image = str(d, k);
        String program = actor != null && str(actor, "app") != null ? str(actor, "app") : image != null ? basename(image) : "a program";
        String id = str(a, "extension_id");
        String who = id != null ? pluginLabel(id, names) : null;
        List<String> chain = new ArrayList<>();
        if (who != null) {
            chain.add(ide);
            chain.add(who);
        }
        chain.add(program);
        boolean paused = a.has("paused") && a.get("paused").getAsBoolean();
        boolean reviewed = a.has("reviewed") && a.get("reviewed").getAsBoolean();
        String line = who != null ? who + " › " + program : actorLine(d.has("actor_chain") && d.get("actor_chain").isJsonArray() ? d.getAsJsonArray("actor_chain") : null, program);
        String kind = String.valueOf(str(a, "kind"));
        long alertId = a.get("id").getAsLong();
        String title0 = actor != null ? str(actor, "title_id") : null;
        if (!"storage_access".equals(kind)) {
            String[] o = otherTitle(kind, d, program, paused);
            Tone tone = "warning".equals(o[2]) ? Tone.WARNING : Tone.CRITICAL;
            String label = "blocked".equals(o[2]) ? "BLOCKED" : paused ? "WOULD BE BLOCKED" : o[2].toUpperCase();
            return new Item("alert-" + alertId, a.get("last_seen_unix").getAsLong(), tone, label, o[0], "", id, who, null, image, title0, chain, alertId, !reviewed, o[2], o[1], line);
        }
        String response = str(d, "access_response");
        String verdict = str(d, "verdict");
        String label = "BLOCKED";
        Tone tone = Tone.CRITICAL;
        String severity = "blocked";
        if (paused) {
            label = "WOULD BE BLOCKED";
            tone = Tone.WARNING;
            severity = "warning";
        } else if ("ask".equalsIgnoreCase(response)) {
            label = "HELD";
            tone = Tone.WARNING;
            severity = "warning";
        } else if ("kill".equalsIgnoreCase(response) || (verdict != null && verdict.startsWith("denied"))) {
            label = "STOPPED";
        } else if ("allowed".equalsIgnoreCase(verdict)) {
            label = "ALLOWED";
            tone = Tone.INFO;
            severity = "warning";
        }
        String app = str(d, "app_name");
        String what = vaultPhrase(app != null ? app : "a protected app", str(d, "data_category"));
        String title = who != null ? "A program " + who + " started tried to read " + what : program + " tried to read " + what;
        return new Item("alert-" + alertId, a.get("last_seen_unix").getAsLong(), tone, label, title, "", id, who, str(d, "resource_id"), image, title0,
            chain, alertId, tone != Tone.INFO && !reviewed, severity, app != null ? app : "", line);
    }

    /** Everything, newest first; the same plugin starting the same program again is one row ("×N"). */
    static List<Item> feed(JsonArray events, JsonArray alerts, Function<String, String> names, String ide) {
        List<Item> out = new ArrayList<>();
        Map<String, Integer> launchAt = new java.util.HashMap<>();
        Map<String, Integer> launchCount = new java.util.HashMap<>();
        if (events != null) for (JsonElement e : events) {
            Item i = event(e.getAsJsonObject(), names);
            if (i == null) continue;
            // the same plugin starting the same program, or refused the same vault again: one row with a count
            if (i.label().equals("STARTED") || i.label().equals("BLOCKED")) {
                String k = i.pluginId() + "\u0000" + i.title();
                Integer at = launchAt.get(k);
                if (at != null) {
                    launchCount.merge(k, 1, Integer::sum);
                    if (i.at() > out.get(at).at()) out.set(at, i);
                    continue;
                }
                launchAt.put(k, out.size());
                launchCount.put(k, 1);
            }
            out.add(i);
        }
        for (Map.Entry<String, Integer> c : launchCount.entrySet()) {
            if (c.getValue() < 2) continue;
            int at = launchAt.get(c.getKey());
            Item i = out.get(at);
            out.set(at, i.withTitle(i.title() + " ×" + c.getValue()));
        }
        if (alerts != null) for (JsonElement a : alerts) {
            Item i = alert(a.getAsJsonObject(), names, ide);
            if (i != null) out.add(i);
        }
        out.sort(Comparator.comparingLong(Item::at).reversed());
        return out;
    }

    static String when(long at, long now) {
        long s = Math.max(0, now - at);
        if (s < 60) return "just now";
        if (s < 3600) return (s / 60) + " min ago";
        java.time.LocalDateTime d = java.time.LocalDateTime.ofEpochSecond(at, 0, java.time.ZoneId.systemDefault().getRules().getOffset(java.time.Instant.ofEpochSecond(at)));
        java.time.LocalDate today = java.time.LocalDate.now();
        String hm = String.format("%02d:%02d", d.getHour(), d.getMinute());
        if (d.toLocalDate().equals(today)) return "Today " + hm;
        return d.getDayOfMonth() + " " + d.getMonth().getDisplayName(java.time.format.TextStyle.SHORT, java.util.Locale.ENGLISH) + " " + hm;
    }

    // ---- vaults (`GET /api/v1/ide/vaults`: what the app's Vaults page lists, with no path in it) ----

    /** The app's words for a vault's state (`ui/src/lib/vaultsData.ts` `STATUS_LABEL`). */
    static final Map<String, String> STATUS_LABEL = Map.of(
        "protected", "Protected", "partial", "Partly protected", "pending", "Needs approval", "watching", "Observed", "empty", "No data yet");

    static final List<String> KIND_ORDER = List.of("wallets", "passwords", "vaults", "secrets", "other");
    static final Map<String, String> KIND_LABEL = Map.of(
        "wallets", "Wallets", "passwords", "Passwords & keychains", "vaults", "Browsers & apps", "secrets", "Keys & developer secrets", "other", "Other");

    record Vault(String id, String name, String where, String kind, String category, String status, int files, int locked, long allowed, long refused) {
        boolean isLocked() { return "protected".equals(status) || "partial".equals(status); }
    }

    record VaultGroup(String kind, String label, List<Vault> vaults, int locked, int observed) {}

    record Vaults(List<VaultGroup> groups, int total, int locked, int observed, int pending, long allowed, long refused, boolean paused) {}

    private static long num(JsonObject o, String k) {
        JsonElement e = o == null ? null : o.get(k);
        return e == null || e.isJsonNull() ? 0 : e.getAsLong();
    }

    /** Vaults by kind (wallets first), locked before observed, then by name; and the totals the screens count. */
    static Vaults vaults(JsonObject answer) {
        JsonArray arr = answer == null ? null : answer.getAsJsonArray("vaults");
        Map<String, String> names = new java.util.HashMap<>();
        if (arr != null) for (JsonElement e : arr) names.put(str(e.getAsJsonObject(), "id"), str(e.getAsJsonObject(), "name"));
        List<Vault> all = new ArrayList<>();
        if (arr != null) for (JsonElement e : arr) {
            JsonObject o = e.getAsJsonObject();
            String name = str(o, "name"), vendor = str(o, "vendor"), parent = str(o, "parent"), kind = str(o, "kind");
            String where = parent != null ? names.getOrDefault(parent, parent) : vendor != null && !vendor.isEmpty() && !vendor.equals(name) ? vendor : "";
            JsonObject week = o.has("week") && o.get("week").isJsonObject() ? o.getAsJsonObject("week") : null;
            all.add(new Vault(str(o, "id"), name == null ? "" : name, where, KIND_ORDER.contains(kind) ? kind : "other", str(o, "category"), String.valueOf(str(o, "status")),
                (int) num(o, "files"), (int) num(o, "locked"), num(week, "allowed"), num(week, "refused")));
        }
        Map<String, Integer> rank = Map.of("protected", 0, "partial", 1, "pending", 2, "watching", 3);
        List<VaultGroup> groups = new ArrayList<>();
        for (String kind : KIND_ORDER) {
            List<Vault> mine = new ArrayList<>(all.stream().filter(v -> v.kind().equals(kind)).toList());
            if (mine.isEmpty()) continue;
            mine.sort(Comparator.<Vault>comparingInt(v -> rank.getOrDefault(v.status(), 4)).thenComparing(Vault::name, String.CASE_INSENSITIVE_ORDER));
            int locked = (int) mine.stream().filter(Vault::isLocked).count();
            groups.add(new VaultGroup(kind, KIND_LABEL.get(kind), mine, locked, mine.size() - locked));
        }
        int locked = (int) all.stream().filter(Vault::isLocked).count();
        boolean paused = answer != null && answer.has("paused") && !answer.get("paused").isJsonNull() && answer.get("paused").getAsBoolean();
        return new Vaults(groups, all.size(), locked, all.size() - locked, (int) all.stream().filter(v -> "pending".equals(v.status())).count(),
            all.stream().mapToLong(Vault::allowed).sum(), all.stream().mapToLong(Vault::refused).sum(), paused);
    }

    /** 1234 -> "1.2k", 12 -> "12". */
    static String compact(long n) {
        if (n < 1000) return String.valueOf(n);
        if (n < 10_000) return trim(String.format(java.util.Locale.ROOT, "%.1f", n / 1000.0)) + "k";
        if (n < 1_000_000) return Math.round(n / 1000.0) + "k";
        return trim(String.format(java.util.Locale.ROOT, "%.1f", n / 1_000_000.0)) + "M";
    }

    private static String trim(String s) {
        return s.endsWith(".0") ? s.substring(0, s.length() - 2) : s;
    }

    static String plural(long n, String one) {
        return n + " " + (n == 1 ? one : one + "s");
    }

    /** BLOCKED -> Blocked, WOULD BE BLOCKED -> Would be blocked: labels read in sentence case (the labels are identifiers). */
    static String word(String label) {
        if (label == null || label.isEmpty()) return "";
        String l = label.toLowerCase(java.util.Locale.ROOT);
        return Character.toUpperCase(l.charAt(0)) + l.substring(1);
    }
}
