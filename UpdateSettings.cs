namespace EntBot.Wpf;

public sealed class UpdateSettings
{
    public string VersionManifestUrl { get; set; } = string.Empty;

    public bool CheckOnStartup { get; set; }
}
