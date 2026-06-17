namespace EntBot.Wpf;

public sealed class UpdaterLaunchInfo
{
    public int ParentProcessId { get; set; }

    public string InstallDirectory { get; set; } = string.Empty;

    public string PackageZipPath { get; set; } = string.Empty;

    public string AppExecutablePath { get; set; } = string.Empty;

    public string RelaunchArguments { get; set; } = string.Empty;

    public string[] CleanupPaths { get; set; } = [];
}
