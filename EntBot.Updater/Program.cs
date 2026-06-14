using System.Diagnostics;
using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

var jsonOptions = new JsonSerializerOptions
{
    WriteIndented = true,
    TypeInfoResolver = new DefaultJsonTypeInfoResolver()
};

var sessionPath = GetArgumentValue(args, "--session");
if (string.IsNullOrWhiteSpace(sessionPath) || !File.Exists(sessionPath))
{
    return;
}

UpdaterLaunchInfo? launchInfo = null;
try
{
    launchInfo = JsonSerializer.Deserialize<UpdaterLaunchInfo>(File.ReadAllText(sessionPath), jsonOptions);
    if (launchInfo is null)
    {
        return;
    }

    WaitForParentExit(launchInfo.ParentProcessId, TimeSpan.FromSeconds(30));

    var stagingDirectory = Path.Combine(Path.GetTempPath(), "EntBotUpdater", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(stagingDirectory);

    var extractDirectory = Path.Combine(stagingDirectory, "extract");
    ZipFile.ExtractToDirectory(launchInfo.PackageZipPath, extractDirectory, overwriteFiles: true);

    ApplyPackage(extractDirectory, launchInfo.InstallDirectory);
    RelaunchApplication(launchInfo);
}
catch
{
    if (launchInfo is not null && File.Exists(launchInfo.AppExecutablePath))
    {
        RelaunchApplication(launchInfo);
    }
}
finally
{
    if (launchInfo is not null)
    {
        foreach (var cleanupPath in launchInfo.CleanupPaths ?? [])
        {
            TryDeletePath(cleanupPath);
        }
    }

    TryDeletePath(sessionPath);
}

static string GetArgumentValue(string[] arguments, string name)
{
    for (var index = 0; index < arguments.Length - 1; index += 1)
    {
        if (string.Equals(arguments[index], name, StringComparison.OrdinalIgnoreCase))
        {
            return arguments[index + 1];
        }
    }

    return string.Empty;
}

static void WaitForParentExit(int processId, TimeSpan timeout)
{
    if (processId <= 0)
    {
        return;
    }

    try
    {
        using var process = Process.GetProcessById(processId);
        if (process.HasExited)
        {
            return;
        }

        process.WaitForExit((int)timeout.TotalMilliseconds);
    }
    catch
    {
        // The parent process is already gone or inaccessible.
    }
}

static void ApplyPackage(string sourceDirectory, string installDirectory)
{
    Directory.CreateDirectory(installDirectory);

    var preservedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "bot-settings.json",
        "update-settings.json"
    };

    foreach (var filePath in Directory.GetFiles(installDirectory))
    {
        var fileName = Path.GetFileName(filePath);
        if (preservedNames.Contains(fileName))
        {
            continue;
        }

        Retry(() => File.Delete(filePath));
    }

    foreach (var directoryPath in Directory.GetDirectories(installDirectory))
    {
        var directoryName = Path.GetFileName(directoryPath);
        if (preservedNames.Contains(directoryName))
        {
            continue;
        }

        Retry(() => Directory.Delete(directoryPath, recursive: true));
    }

    foreach (var sourcePath in Directory.GetDirectories(sourceDirectory, "*", SearchOption.AllDirectories))
    {
        var relativePath = Path.GetRelativePath(sourceDirectory, sourcePath);
        Directory.CreateDirectory(Path.Combine(installDirectory, relativePath));
    }

    foreach (var sourcePath in Directory.GetFiles(sourceDirectory, "*", SearchOption.AllDirectories))
    {
        var relativePath = Path.GetRelativePath(sourceDirectory, sourcePath);
        var destinationPath = Path.Combine(installDirectory, relativePath);
        var destinationDirectory = Path.GetDirectoryName(destinationPath);
        if (!string.IsNullOrWhiteSpace(destinationDirectory))
        {
            Directory.CreateDirectory(destinationDirectory);
        }

        var fileName = Path.GetFileName(destinationPath);
        if (preservedNames.Contains(fileName) && File.Exists(destinationPath))
        {
            continue;
        }

        Retry(() => File.Copy(sourcePath, destinationPath, overwrite: true));
    }
}

static void RelaunchApplication(UpdaterLaunchInfo launchInfo)
{
    if (!File.Exists(launchInfo.AppExecutablePath))
    {
        return;
    }

    var startInfo = new ProcessStartInfo
    {
        FileName = launchInfo.AppExecutablePath,
        Arguments = launchInfo.RelaunchArguments ?? string.Empty,
        WorkingDirectory = Path.GetDirectoryName(launchInfo.AppExecutablePath) ?? launchInfo.InstallDirectory,
        UseShellExecute = true
    };

    Process.Start(startInfo);
}

static void Retry(Action action, int attempts = 10, int delayMs = 500)
{
    Exception? lastError = null;

    for (var attempt = 1; attempt <= attempts; attempt += 1)
    {
        try
        {
            action();
            return;
        }
        catch (Exception ex)
        {
            lastError = ex;
            if (attempt == attempts)
            {
                break;
            }

            Thread.Sleep(delayMs);
        }
    }

    if (lastError is not null)
    {
        throw lastError;
    }
}

static void TryDeletePath(string? path)
{
    if (string.IsNullOrWhiteSpace(path))
    {
        return;
    }

    try
    {
        if (Directory.Exists(path))
        {
            Directory.Delete(path, recursive: true);
            return;
        }

        if (File.Exists(path))
        {
            File.Delete(path);
        }
    }
    catch
    {
        // ignore cleanup failures
    }
}

internal sealed class UpdaterLaunchInfo
{
    public int ParentProcessId { get; set; }

    public string InstallDirectory { get; set; } = string.Empty;

    public string PackageZipPath { get; set; } = string.Empty;

    public string AppExecutablePath { get; set; } = string.Empty;

    public string RelaunchArguments { get; set; } = string.Empty;

    public string[] CleanupPaths { get; set; } = [];
}
