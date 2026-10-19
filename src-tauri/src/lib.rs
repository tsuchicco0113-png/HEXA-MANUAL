mod pdf;

/// プレビュー HTML の書き出し用。
/// plugin-fs のスコープ設定を持ち込まずに済ませるための最小コマンド。
/// 保存先はダイアログでユーザーが選んだパスのみが渡る前提。
#[tauri::command]
fn save_text(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_text,
            pdf::generate_pdf,
            pdf::detect_browser,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
