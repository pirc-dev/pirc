// swift-tools-version:5.9
// The iOS notification extension's core (docs/design.md, section 12, step
// 13): logs in to the relay with the read-only key, reads the session list
// and writes the notifications, as web/core/notices.ts does; and, over
// libsodium, checks a version of the account's device list and opens a
// session's sealed notice (docs/e2e.md, sections 3 and 5). Pure: the
// extension target reads and writes storage and posts what it returns.
import PackageDescription

let package = Package(
    name: "PircNotices",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "PircNotices", targets: ["PircNotices"])],
    dependencies: [
        .package(url: "https://github.com/apple/swift-protobuf.git", exact: "1.39.0"),
        // libsodium 1.0.22 as a prebuilt static xcframework, the same as tag
        // 0.11.0 carries. Only its C module is used.
        .package(url: "https://github.com/jedisct1/swift-sodium.git", revision: "fbe072d70df9dbe43adbc4f6ae5787ee59fd376e"),
    ],
    targets: [
        .target(
            name: "PircNotices",
            dependencies: [
                .product(name: "SwiftProtobuf", package: "swift-protobuf"),
                .product(name: "Clibsodium", package: "swift-sodium"),
            ]
        ),
        // The tests seal and sign through the C module too.
        .testTarget(name: "PircNoticesTests", dependencies: ["PircNotices", .product(name: "Clibsodium", package: "swift-sodium")]),
    ]
)
