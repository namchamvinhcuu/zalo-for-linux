// nativelibs/zcall/src/main.cc
//
// Linux reimplementation of Zalo's `zcall` voice/video native addon — SCAFFOLD.
//
// Status: skeleton only. It exports the full N-API surface the JS layer
// (app/native/nativelibs/zcall/vcmac.js + index.js) expects, but the methods
// are stubs. This makes the addon build + load on Linux and pass the
// availability check (`test(123) === 123`). It does NOT place real calls yet.
//
// API surface (from vcmac.js):
//   MainApp() -> instance; instance methods:
//   test, stop, setConfig(12 args), setMediaConfig, setListServers,
//   setConfigServer, setState, updateCallerInfo, makeCall, incomingCall, mute,
//   holdAudio, stopCapture, setCallback, getEventMessage, getVideoFrame,
//   getVideoFrameLocal, startDesktopCapture, stopDesktopCapture,
//   changeMinMaxMobileBitrate, getListDevices, changeAudioDevice,
//   changeVideoDevice, setAudioVolume, setAgc, getCallInfo, getJsonStats406,
//   getActiveAudioCodecs, getExtendData
//
// Roadmap (historical — superseded by the route-B Wine bridge, see ../zcall-bridge):
//   Phase 2  Capture a real call (RTP/RTCP to relay servers + ZRTP handshake)
//            to reverse the wire format.  <-- DECISION GATE, do before the engine.
//   Phase 3  Audio-only: libwebrtc base + ALSA/PulseAudio I/O + Opus codec +
//            RTP/RTCP to Zalo relay servers + ZRTP key exchange.
//   Phase 4  Video: VP8/VP9/H264 + V4L2 capture + getVideoFrame() decode path.
//   Phase 5  Devices, stats, desktop capture, FEC, AGC, bitrate control.

#include <napi.h>
#include <string>

class ZCall : public Napi::ObjectWrap<ZCall> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  static Napi::Value MainApp(const Napi::CallbackInfo& info);
  explicit ZCall(const Napi::CallbackInfo& info) : Napi::ObjectWrap<ZCall>(info) {}

 private:
  static Napi::FunctionReference constructor;
  Napi::FunctionReference eventCallback_;  // native -> JS, set via setCallback

  // Sanity check used by JS check(): must echo its numeric argument.
  Napi::Value Test(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) return env.Null();
    return Napi::Number::New(env, info[0].As<Napi::Number>().DoubleValue());
  }

  // --- call setup (TODO: phase 3+) ---
  void SetConfig(const Napi::CallbackInfo&) {}
  void SetMediaConfig(const Napi::CallbackInfo&) {}
  void SetListServers(const Napi::CallbackInfo&) {}
  void SetConfigServer(const Napi::CallbackInfo&) {}
  void SetState(const Napi::CallbackInfo&) {}
  void UpdateCallerInfo(const Napi::CallbackInfo&) {}

  // --- call control (TODO: phase 3+) ---
  void MakeCall(const Napi::CallbackInfo&) {}
  void IncomingCall(const Napi::CallbackInfo&) {}
  void Mute(const Napi::CallbackInfo&) {}
  void HoldAudio(const Napi::CallbackInfo&) {}
  void StopCapture(const Napi::CallbackInfo&) {}
  void Stop(const Napi::CallbackInfo&) {}
  void ChangeMinMaxMobileBitrate(const Napi::CallbackInfo&) {}
  void StartDesktopCapture(const Napi::CallbackInfo&) {}
  void StopDesktopCapture(const Napi::CallbackInfo&) {}

  // --- devices (TODO: phase 5) ---
  void ChangeAudioDevice(const Napi::CallbackInfo&) {}
  void ChangeVideoDevice(const Napi::CallbackInfo&) {}
  void SetAgc(const Napi::CallbackInfo&) {}
  Napi::Value SetAudioVolume(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), false);
  }
  Napi::Value GetListDevices(const Napi::CallbackInfo& info) {
    return Napi::Array::New(info.Env());  // [] until enumerated
  }

  // --- events (TODO: phase 3) ---
  void SetCallback(const Napi::CallbackInfo& info) {
    if (info.Length() >= 1 && info[0].IsFunction())
      eventCallback_ = Napi::Persistent(info[0].As<Napi::Function>());
  }
  Napi::Value GetEventMessage(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), "");  // empty = no pending event
  }

  // --- video frames (TODO: phase 4) ---
  Napi::Value GetVideoFrame(const Napi::CallbackInfo& info) { return info.Env().Null(); }
  Napi::Value GetVideoFrameLocal(const Napi::CallbackInfo& info) { return info.Env().Null(); }

  // --- stats (TODO: phase 5) ---
  Napi::Value GetCallInfo(const Napi::CallbackInfo& info) { return info.Env().Null(); }
  Napi::Value GetJsonStats406(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), "");
  }
  Napi::Value GetActiveAudioCodecs(const Napi::CallbackInfo& info) {
    return Napi::Array::New(info.Env());
  }
  Napi::Value GetExtendData(const Napi::CallbackInfo& info) { return info.Env().Null(); }
};

Napi::FunctionReference ZCall::constructor;

Napi::Value ZCall::MainApp(const Napi::CallbackInfo& info) {
  return constructor.New({});
}

Napi::Object ZCall::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "ZCall", {
      InstanceMethod("test", &ZCall::Test),
      InstanceMethod("stop", &ZCall::Stop),
      InstanceMethod("setConfig", &ZCall::SetConfig),
      InstanceMethod("setMediaConfig", &ZCall::SetMediaConfig),
      InstanceMethod("setListServers", &ZCall::SetListServers),
      InstanceMethod("setConfigServer", &ZCall::SetConfigServer),
      InstanceMethod("setState", &ZCall::SetState),
      InstanceMethod("updateCallerInfo", &ZCall::UpdateCallerInfo),
      InstanceMethod("makeCall", &ZCall::MakeCall),
      InstanceMethod("incomingCall", &ZCall::IncomingCall),
      InstanceMethod("mute", &ZCall::Mute),
      InstanceMethod("holdAudio", &ZCall::HoldAudio),
      InstanceMethod("stopCapture", &ZCall::StopCapture),
      InstanceMethod("changeMinMaxMobileBitrate", &ZCall::ChangeMinMaxMobileBitrate),
      InstanceMethod("startDesktopCapture", &ZCall::StartDesktopCapture),
      InstanceMethod("stopDesktopCapture", &ZCall::StopDesktopCapture),
      InstanceMethod("changeAudioDevice", &ZCall::ChangeAudioDevice),
      InstanceMethod("changeVideoDevice", &ZCall::ChangeVideoDevice),
      InstanceMethod("setAgc", &ZCall::SetAgc),
      InstanceMethod("setAudioVolume", &ZCall::SetAudioVolume),
      InstanceMethod("getListDevices", &ZCall::GetListDevices),
      InstanceMethod("setCallback", &ZCall::SetCallback),
      InstanceMethod("getEventMessage", &ZCall::GetEventMessage),
      InstanceMethod("getVideoFrame", &ZCall::GetVideoFrame),
      InstanceMethod("getVideoFrameLocal", &ZCall::GetVideoFrameLocal),
      InstanceMethod("getCallInfo", &ZCall::GetCallInfo),
      InstanceMethod("getJsonStats406", &ZCall::GetJsonStats406),
      InstanceMethod("getActiveAudioCodecs", &ZCall::GetActiveAudioCodecs),
      InstanceMethod("getExtendData", &ZCall::GetExtendData),
  });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();

  // The JS binding does `ZMacCall.MainApp()` to get the instance.
  exports.Set("MainApp", Napi::Function::New(env, &ZCall::MainApp));
  return exports;
}

// NODE_API_MODULE token-pastes the init name, so it must be an unqualified
// identifier — wrap the static member in a free function.
static Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  return ZCall::Init(env, exports);
}

NODE_API_MODULE(zcall_native, InitModule)
