// 把另一個程式的視窗「貼齊」在 EasyRead 旁邊用的小幫手（只有 macOS）。
//
// macOS 不讓一個程式把別的程式的視窗放進自己的視窗裡；能做的是請系統（輔助使用／Accessibility）把那個視窗
// 移到指定的位置、改成指定的大小。EasyRead 的主程式（electron/native-dock.cjs）讓出右邊那一塊，叫這個幫手
// 把對方的視窗擺進去，EasyRead 的視窗移動、改大小時再跟著擺一次。
//
// 和主程式用一行一個 JSON 溝通（stdin 收指令、stdout 回覆和通知）：
//   {"id":1,"cmd":"trust","prompt":false}                → {"id":1,"ok":true,"trusted":true}
//   {"id":2,"cmd":"attach","path":"/Applications/X.app","frame":[x,y,w,h]} → {"id":2,"ok":true,"frame":[…實際擺成的]}
//   {"cmd":"frame","frame":[x,y,w,h]}                    （不回覆）
//   {"id":3,"cmd":"detach","restore":true}               → {"id":3,"ok":true}
//   通知：{"event":"gone"}（那個程式關了、視窗關了）、{"event":"frame","frame":[…]}（使用者自己動了那個視窗）
// 兩個程式當成一組：從別的程式切回其中一個時，另一個也叫到前面（不然會被第三個視窗蓋住）。
// --dry：不碰任何視窗，只回覆（開發時測主程式那一邊的算法用）。
import AppKit
import ApplicationServices

let dry = CommandLine.arguments.contains("--dry")
let hostPid: pid_t = getppid()
var companion: NSRunningApplication?
var window: AXUIElement?
var observer: AXObserver?
var original: CGRect?
var lastSet = CGRect.zero
var lastActive: pid_t = 0
var quietUntil = Date.distantPast
var generation = 0

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj), let text = String(data: data, encoding: .utf8) else { return }
  FileHandle.standardOutput.write((text + "\n").data(using: .utf8)!)
}
func list(_ r: CGRect) -> [Double] { [Double(r.origin.x), Double(r.origin.y), Double(r.size.width), Double(r.size.height)] }
func rect(_ a: Any?) -> CGRect? {
  guard let v = a as? [NSNumber], v.count == 4 else { return nil }
  return CGRect(x: v[0].doubleValue, y: v[1].doubleValue, width: v[2].doubleValue, height: v[3].doubleValue)
}

func frameOf(_ w: AXUIElement) -> CGRect? {
  var p: CFTypeRef?
  var s: CFTypeRef?
  guard AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &p) == .success,
        AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &s) == .success, let pv = p, let sv = s else { return nil }
  var point = CGPoint.zero
  var size = CGSize.zero
  AXValueGetValue(pv as! AXValue, .cgPoint, &point)
  AXValueGetValue(sv as! AXValue, .cgSize, &size)
  return CGRect(origin: point, size: size)
}
func setFrame(_ w: AXUIElement, _ r: CGRect) {
  var point = r.origin
  var size = r.size
  // 先改大小、再移、再改一次大小：有些程式在舊位置不肯變到那個大小（會超出螢幕）
  if let v = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, v) }
  if let v = AXValueCreate(.cgPoint, &point) { AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, v) }
  if let v = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, v) }
  lastSet = frameOf(w) ?? r
}
func mainWindow(of pid: pid_t) -> AXUIElement? {
  let app = AXUIElementCreateApplication(pid)
  var v: CFTypeRef?
  if AXUIElementCopyAttributeValue(app, kAXMainWindowAttribute as CFString, &v) == .success, let w = v { return (w as! AXUIElement) }
  if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &v) == .success, let all = v as? [AXUIElement] {
    for w in all {
      var sub: CFTypeRef?
      if AXUIElementCopyAttributeValue(w, kAXSubroleAttribute as CFString, &sub) == .success, (sub as? String) == (kAXStandardWindowSubrole as String) { return w }
    }
    return all.first
  }
  return nil
}
func bringForward(_ pid: pid_t) {
  AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
  if let c = companion, c.processIdentifier == pid, let w = window { AXUIElementPerformAction(w, kAXRaiseAction as CFString) }
}

// 視窗被使用者移動、改大小、關掉
let onWindowEvent: AXObserverCallback = { _, element, notification, _ in
  let name = notification as String
  if name == (kAXUIElementDestroyedNotification as String) { release(restore: false); emit(["event": "gone"]); return }
  guard let w = window, let now = frameOf(w) else { return }
  if abs(now.origin.x - lastSet.origin.x) < 2 && abs(now.origin.y - lastSet.origin.y) < 2 && abs(now.width - lastSet.width) < 2 && abs(now.height - lastSet.height) < 2 { return }  // 是我們自己擺的
  emit(["event": "frame", "frame": list(now)])
}
func watch(_ w: AXUIElement, pid: pid_t) {
  var obs: AXObserver?
  guard AXObserverCreate(pid, onWindowEvent, &obs) == .success, let o = obs else { return }
  for n in [kAXMovedNotification, kAXResizedNotification, kAXUIElementDestroyedNotification] { AXObserverAddNotification(o, w, n as CFString, nil) }
  CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode)
  observer = o
}
func release(restore: Bool) {
  generation += 1
  if let o = observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode) }
  if restore, let w = window, let r = original { setFrame(w, r) }
  observer = nil; window = nil; companion = nil; original = nil
}

func attach(id: Any?, path: String, frame: CGRect) {
  release(restore: true)
  if dry { lastSet = frame; emit(["id": id ?? NSNull(), "ok": true, "frame": list(frame), "dry": true]); return }
  let url = URL(fileURLWithPath: path)
  let gen = generation
  let cfg = NSWorkspace.OpenConfiguration()
  cfg.activates = false
  // 已經開著也再「開」一次：沒有視窗的（只剩 Dock 圖示）會把視窗開回來
  NSWorkspace.shared.openApplication(at: url, configuration: cfg) { app, error in
    DispatchQueue.main.async {
      guard gen == generation else { return }
      guard let app = app else { emit(["id": id ?? NSNull(), "ok": false, "reason": "launch", "message": error?.localizedDescription ?? ""]); return }
      var tries = 0
      func look() {
        guard gen == generation else { return }
        if let w = mainWindow(of: app.processIdentifier) {
          companion = app; window = w; original = frameOf(w)
          setFrame(w, frame)
          watch(w, pid: app.processIdentifier)
          AXUIElementPerformAction(w, kAXRaiseAction as CFString)
          emit(["id": id ?? NSNull(), "ok": true, "frame": list(lastSet), "pid": Int(app.processIdentifier)])
          return
        }
        tries += 1
        if tries > 60 { emit(["id": id ?? NSNull(), "ok": false, "reason": "nowindow"]); return }  // 等了 12 秒還沒有視窗
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: look)
      }
      look()
    }
  }
}

func handle(_ line: String) {
  guard let data = line.data(using: .utf8), let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let cmd = msg["cmd"] as? String else { return }
  let id = msg["id"]
  switch cmd {
  case "trust":
    let prompt = (msg["prompt"] as? Bool) ?? false
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    emit(["id": id ?? NSNull(), "ok": true, "trusted": dry ? true : AXIsProcessTrustedWithOptions(opts)])
  case "attach":
    guard let path = msg["path"] as? String, let frame = rect(msg["frame"]) else { emit(["id": id ?? NSNull(), "ok": false, "reason": "args"]); return }
    if !dry && !AXIsProcessTrusted() { emit(["id": id ?? NSNull(), "ok": false, "reason": "permission"]); return }
    attach(id: id, path: path, frame: frame)
  case "frame":
    guard let frame = rect(msg["frame"]) else { return }
    if dry { lastSet = frame; emit(["event": "dry-frame", "frame": list(frame)]); return }
    if let w = window { setFrame(w, frame) }
  case "detach":
    release(restore: (msg["restore"] as? Bool) ?? true)
    emit(["id": id ?? NSNull(), "ok": true])
  default:
    emit(["id": id ?? NSNull(), "ok": false, "reason": "unknown"])
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)  // 沒有 Dock 圖示、不會搶到前面

// 那個程式關了
NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { note in
  guard let gone = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, let c = companion, gone.processIdentifier == c.processIdentifier else { return }
  release(restore: false)
  emit(["event": "gone"])
}
// 兩個程式當成一組：從第三個程式切回其中一個，另一個也叫到前面
NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
  guard let active = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
  let pid = active.processIdentifier
  let before = lastActive
  lastActive = pid
  guard !dry, let c = companion, window != nil, Date() > quietUntil else { return }
  let other = c.processIdentifier
  guard (pid == hostPid || pid == other), before != hostPid, before != other else { return }
  quietUntil = Date().addingTimeInterval(0.8)  // 下面兩下也會觸發這個通知：這段時間不再反應
  bringForward(pid == hostPid ? other : hostPid)
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { bringForward(pid) }
}

// 讀指令；主程式沒了（stdin 關了）就把視窗放回原位再結束
Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) { DispatchQueue.main.async { handle(line) } }
  DispatchQueue.main.async { release(restore: true); exit(0) }
}
app.run()
