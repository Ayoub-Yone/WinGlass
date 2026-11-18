//! Backend-side strings (tray menu, native toasts). Everything else is localized in the webviews
//! (`src/i18n/translations.ts`); keep the two in sync when wording changes.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Fr,
    En,
}

impl Lang {
    /// French is the default for anything that is not explicitly English.
    pub fn parse(code: &str) -> Lang {
        if code.eq_ignore_ascii_case("en") { Lang::En } else { Lang::Fr }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Text {
    TraySettings,
    TrayAddWidgets,
    TrayRestore,
    TrayRestoreQuit,
    PickerTitle,
    SettingsTitle,
    ToastTaskbarRestored,
    ToastTaskbarRestoredSub,
}

pub fn tr(lang: Lang, text: Text) -> &'static str {
    match (lang, text) {
        (Lang::Fr, Text::TraySettings) => "Paramètres…",
        (Lang::En, Text::TraySettings) => "Settings…",
        (Lang::Fr, Text::TrayAddWidgets) => "Ajouter des widgets…",
        (Lang::En, Text::TrayAddWidgets) => "Add Widgets…",
        (Lang::Fr, Text::TrayRestore) => "Restaurer la barre des tâches",
        (Lang::En, Text::TrayRestore) => "Restore Windows Taskbar",
        (Lang::Fr, Text::TrayRestoreQuit) => "Restaurer la barre des tâches et quitter",
        (Lang::En, Text::TrayRestoreQuit) => "Restore Windows Taskbar & Quit",
        (Lang::Fr, Text::PickerTitle) => "Ajouter des widgets",
        (Lang::En, Text::PickerTitle) => "Add Widgets",
        (Lang::Fr, Text::SettingsTitle) => "Paramètres WinGlass",
        (Lang::En, Text::SettingsTitle) => "WinGlass Settings",
        (Lang::Fr, Text::ToastTaskbarRestored) => "Barre des tâches Windows restaurée",
        (Lang::En, Text::ToastTaskbarRestored) => "Windows taskbar restored",
        (Lang::Fr, Text::ToastTaskbarRestoredSub) => "Ctrl + Alt + Maj + R · WinGlass reste ouvert",
        (Lang::En, Text::ToastTaskbarRestoredSub) => "Ctrl + Alt + Shift + R · WinGlass keeps running",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn french_is_the_default_language() {
        assert_eq!(Lang::parse("fr"), Lang::Fr);
        assert_eq!(Lang::parse(""), Lang::Fr);
        assert_eq!(Lang::parse("de"), Lang::Fr);
        assert_eq!(Lang::parse("EN"), Lang::En);
    }

    #[test]
    fn tray_strings_switch_with_the_language() {
        assert_eq!(tr(Lang::Fr, Text::TrayRestoreQuit), "Restaurer la barre des tâches et quitter");
        assert_eq!(tr(Lang::En, Text::TrayRestoreQuit), "Restore Windows Taskbar & Quit");
        assert_ne!(tr(Lang::Fr, Text::TraySettings), tr(Lang::En, Text::TraySettings));
    }
}
