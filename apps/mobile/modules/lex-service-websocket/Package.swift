// swift-tools-version: 5.9
import PackageDescription

// Foundation transport tests run on macOS without Expo or an iOS signing identity.
let package = Package(
  name: "LexServiceTransport",
  platforms: [.macOS(.v12), .iOS(.v16)],
  targets: [
    .target(name: "LexServiceTransport", path: "ios",
            exclude: ["LexServiceWebSocketModule.swift", "LexServiceWebSocketModule.podspec"]),
    .testTarget(name: "LexServiceTransportTests", dependencies: ["LexServiceTransport"], path: "ios-tests"),
  ]
)
