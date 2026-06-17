namespace EntBot.Wpf;

public sealed class UpdateManifest
{
    public string Version { get; set; } = "1.0.0";

    public string PackageUrl { get; set; } = string.Empty;

    public string Sha256 { get; set; } = string.Empty;

    public string PublishedAtUtc { get; set; } = string.Empty;

    public string ReleaseNotes { get; set; } = string.Empty;
}
