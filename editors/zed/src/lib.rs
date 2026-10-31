use zed_extension_api::{self as zed, settings::LspSettings};

struct Liva;

impl zed::Extension for Liva {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> zed::Result<zed::Command> {
        let settings = LspSettings::for_worktree(id.as_ref(), worktree)?;
        let binary = settings.binary;
        let command = binary
            .as_ref()
            .and_then(|binary| binary.path.clone())
            .or_else(|| worktree.which("liva-lsp"))
            .ok_or("Install liva-lsp on PATH or set lsp.liva.binary.path in Zed settings")?;

        Ok(zed::Command {
            command,
            args: binary
                .and_then(|binary| binary.arguments)
                .unwrap_or_default(),
            env: Default::default(),
        })
    }
}

zed::register_extension!(Liva);
