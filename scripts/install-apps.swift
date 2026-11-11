import AppKit
import Foundation
// No bundle-id-wide quit: a termination request must match the exact executable.
let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 3, ["list", "quit", "registered"].contains(args[0]), args[2].hasPrefix("/") else { exit(64) }
if args[0] == "registered" {
    let paths = NSWorkspace.shared.urlsForApplications(withBundleIdentifier: args[1]).map { $0.path }.sorted()
    let data = try JSONSerialization.data(withJSONObject: paths)
    print(String(data: data, encoding: .utf8)!)
    exit(0)
}
let apps = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == args[1] }
if args[0] == "quit" {
    for app in apps {
        guard app.executableURL?.path == args[2] else { exit(65) }
    }
    for app in apps { if !app.terminate() { exit(66) } }
}
let rows = apps.map { ["pid": Int($0.processIdentifier), "executable": $0.executableURL?.path ?? "", "finishedLaunching": $0.isFinishedLaunching] as [String: Any] }
let data = try JSONSerialization.data(withJSONObject: rows)
print(String(data: data, encoding: .utf8)!)
