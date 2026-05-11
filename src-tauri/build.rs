use tauri_build::{Attributes, CodegenContext, InlinedPlugin};

fn main() {
    tauri_build::try_build(
        Attributes::new()
            .codegen(CodegenContext::new())
            .plugin(
                "device-manager",
                InlinedPlugin::new().commands(&[
                    "list",
                    "set_default",
                    "add",
                    "remove",
                    "novacom_getkey",
                    "localkey_verify",
                    "privkey_read",
                    "check_connection",
                    "app_ssh_key_path",
                    "app_ssh_pubkey",
                    "ssh_key_dir",
                ]),
            )
            .plugin(
                "remote-command",
                InlinedPlugin::new().commands(&["exec", "spawn"]),
            )
            .plugin(
                "remote-shell",
                InlinedPlugin::new()
                    .commands(&["open", "close", "write", "resize", "screen", "list"]),
            )
            .plugin(
                "remote-file",
                InlinedPlugin::new()
                    .commands(&["ls", "read", "write", "get", "put", "get_temp", "serve"]),
            )
            .plugin(
                "dev-mode",
                InlinedPlugin::new().commands(&["status", "token"]),
            )
            .plugin(
                "local-file",
                InlinedPlugin::new().commands(&["checksum", "remove", "copy", "temp_path"]),
            )
            .plugin(
                "adb-manager",
                InlinedPlugin::new().commands(&[
                    "adb_list_devices",
                    "adb_connect",
                    "adb_disconnect",
                    "adb_list_packages",
                    "adb_get_prop",
                    "adb_launch",
                    "adb_force_stop",
                    "adb_uninstall",
                    "adb_install",
                    "tizen_connect",
                    "tizen_install",
                    "tizen_uninstall",
                    "tizen_list_apps",
                    "tizen_get_device_info",
                    "tizen_launch",
                    "tizen_kill",
                    "tizen_debug",
                    "tizen_get_duid",
                    "tizen_shell",
                    "tizen_daemon_command",
                    "tizen_get_app_version",
                    "tizen_install_tizen_brew",
                    "tizen_tizen_brew_device_details",
                ]),
            )
            .plugin(
                "vidaa",
                InlinedPlugin::new().commands(&[
                    "get_device_info",
                    "get_pages",
                    "list_apps",
                    "install_app",
                    "uninstall_app",
                ]),
            ),
    )
    .expect("failed to run tauri-build");
}
