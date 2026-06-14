using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;
using System.Windows;
using System.Windows.Controls;

namespace EntBot.Wpf;

public partial class MainWindow : Window
{
    private readonly string _settingsPath = Path.Combine(AppContext.BaseDirectory, "bot-settings.json");
    private readonly string _botDirectory = Path.Combine(AppContext.BaseDirectory, "bot");
    private readonly string _bundledNodeDirectory = Path.Combine(AppContext.BaseDirectory, "runtime", "node");
    private readonly JsonSerializerOptions _jsonOptions = new()
    {
        WriteIndented = true,
        TypeInfoResolver = new DefaultJsonTypeInfoResolver()
    };
    private Process? _botProcess;
    private bool _isStopping;

    public MainWindow()
    {
        InitializeComponent();
        ApplyDefaultSettings();
        LoadSettingsFromDisk();
        UpdateUiState();
        AppendLog($"[App] Settings file: {_settingsPath}");
        AppendLog($"[App] Bot runtime folder: {_botDirectory}");
        AppendLog($"[App] Bundled Node folder: {_bundledNodeDirectory}");
    }

    private bool IsBotRunning => _botProcess is { HasExited: false };

    private void SaveButton_OnClick(object sender, RoutedEventArgs e)
    {
        SaveSettingsToDisk(showDialogOnSuccess: true);
    }

    private void ReloadButton_OnClick(object sender, RoutedEventArgs e)
    {
        LoadSettingsFromDisk();
        AppendLog("[App] Settings reloaded.");
    }

    private void ClearLogButton_OnClick(object sender, RoutedEventArgs e)
    {
        LogTextBox.Clear();
    }

    private void StartButton_OnClick(object sender, RoutedEventArgs e)
    {
        if (IsBotRunning)
        {
            return;
        }

        if (!SaveSettingsToDisk(showDialogOnSuccess: false))
        {
            return;
        }

        var missingFields = GetMissingRequiredFields();
        if (missingFields.Length > 0)
        {
            var message = $"Fill in the required settings before starting: {string.Join(", ", missingFields)}";
            AppendLog($"[App] {message}");
            MessageBox.Show(
                this,
                message,
                "Missing Required Settings",
                MessageBoxButton.OK,
                MessageBoxImage.Warning
            );
            SetStatus("Missing Required Settings");
            UpdateUiState();
            return;
        }

        if (!File.Exists(Path.Combine(_botDirectory, "index.js")))
        {
            AppendLog("[App] Bot runtime files were not found in the desktop build output.");
            MessageBox.Show(
                this,
                "The bundled bot runtime was not copied into the WPF output folder.",
                "Missing Bot Runtime",
                MessageBoxButton.OK,
                MessageBoxImage.Error
            );
            return;
        }

        var nodeExecutablePath = ResolveNodeExecutablePath();
        var startInfo = new ProcessStartInfo
        {
            FileName = nodeExecutablePath,
            Arguments = "index.js",
            WorkingDirectory = _botDirectory,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        startInfo.Environment["ENT_BOT_SETTINGS_FILE"] = _settingsPath;

        var process = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true
        };

        process.OutputDataReceived += (_, args) =>
        {
            if (!string.IsNullOrWhiteSpace(args.Data))
            {
                AppendLog(args.Data);
            }
        };

        process.ErrorDataReceived += (_, args) =>
        {
            if (!string.IsNullOrWhiteSpace(args.Data))
            {
                AppendLog(args.Data);
            }
        };

        process.Exited += (_, _) =>
        {
            var exitCode = process.ExitCode;
            _ = Dispatcher.InvokeAsync(() =>
            {
                AppendLog($"[App] Bot exited with code {exitCode}.");
                if (ReferenceEquals(_botProcess, process))
                {
                    _botProcess = null;
                }

                _isStopping = false;
                process.Dispose();
                SetStatus("Stopped");
                UpdateUiState();
            });
        };

        try
        {
            if (!process.Start())
            {
                AppendLog("[App] Failed to start the bot process.");
                process.Dispose();
                return;
            }

            _botProcess = process;
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            AppendLog($"[App] Bot process started with runtime: {nodeExecutablePath}");
            SetStatus("Running");
            UpdateUiState();
        }
        catch (Exception ex)
        {
            process.Dispose();
            AppendLog($"[App] Failed to start Node.js: {ex.Message}");
            MessageBox.Show(
                this,
                "The app could not start Node.js. Bundle node.exe into runtime\\node\\node.exe for standalone builds, or keep Node on PATH while developing.",
                "Node.js Launch Failed",
                MessageBoxButton.OK,
                MessageBoxImage.Error
            );
        }
    }

    private async void StopButton_OnClick(object sender, RoutedEventArgs e)
    {
        await ShutdownBotAsync();
    }

    private async Task ShutdownBotAsync()
    {
        var process = _botProcess;
        if (process is null || process.HasExited || _isStopping)
        {
            return;
        }

        _isStopping = true;
        SetStatus("Stopping");
        UpdateUiState();
        AppendLog("[App] Sending shutdown command to the bot.");

        try
        {
            process.StandardInput.WriteLine("shutdown");
            process.StandardInput.Flush();
        }
        catch (Exception ex)
        {
            AppendLog($"[App] Could not send shutdown command: {ex.Message}");
        }

        try
        {
            var waitForExitTask = process.WaitForExitAsync();
            var completedTask = await Task.WhenAny(waitForExitTask, Task.Delay(5000));
            if (completedTask == waitForExitTask)
            {
                await waitForExitTask;
                return;
            }

            AppendLog("[App] Graceful shutdown timed out. Terminating process.");

            try
            {
                process.Kill(true);
                await process.WaitForExitAsync();
            }
            catch (Exception ex)
            {
                AppendLog($"[App] Failed to terminate the bot process: {ex.Message}");
            }
        }
        finally
        {
            if (_botProcess is null || _botProcess.HasExited)
            {
                _isStopping = false;
                UpdateUiState();
            }
        }
    }

    private void MainWindow_OnClosing(object? sender, CancelEventArgs e)
    {
        var process = _botProcess;
        if (process is null || process.HasExited)
        {
            return;
        }

        try
        {
            process.StandardInput.WriteLine("shutdown");
            process.StandardInput.Flush();

            if (!process.WaitForExit(2000))
            {
                process.Kill(true);
            }
        }
        catch
        {
            try
            {
                process.Kill(true);
            }
            catch
            {
                // ignore close-time cleanup failures
            }
        }
    }

    private bool SaveSettingsToDisk(bool showDialogOnSuccess)
    {
        try
        {
            var settings = BuildSettingsJson();
            File.WriteAllText(_settingsPath, settings.ToJsonString(_jsonOptions));
            AppendLog("[App] Settings saved.");

            if (showDialogOnSuccess)
            {
                MessageBox.Show(
                    this,
                    "Settings saved.",
                    "Ent Bot",
                    MessageBoxButton.OK,
                    MessageBoxImage.Information
                );
            }

            return true;
        }
        catch (Exception ex)
        {
            AppendLog($"[App] Failed to save settings: {ex.Message}");
            MessageBox.Show(
                this,
                ex.Message,
                "Invalid Settings",
                MessageBoxButton.OK,
                MessageBoxImage.Error
            );
            return false;
        }
    }

    private void LoadSettingsFromDisk()
    {
        if (!File.Exists(_settingsPath))
        {
            ApplyDefaultSettings();
            return;
        }

        try
        {
            var node = JsonNode.Parse(File.ReadAllText(_settingsPath));
            if (node is not JsonObject root)
            {
                throw new InvalidOperationException("The saved settings file does not contain a JSON object.");
            }

            ApplySettings(root);
        }
        catch (Exception ex)
        {
            ApplyDefaultSettings();
            AppendLog($"[App] Failed to load settings file. Defaults were restored. {ex.Message}");
        }
    }

    private JsonObject BuildSettingsJson()
    {
        var entBot = new JsonObject
        {
            ["loginAddress"] = NormalizeText(LoginAddressTextBox.Text),
            ["loginPort"] = ReadInt(LoginPortTextBox, "Login port", 44553),
            ["username"] = NormalizeText(UsernameTextBox.Text),
            ["password"] = PasswordBox.Password ?? string.Empty,
            ["character"] = NormalizeText(CharacterTextBox.Text),
            ["performanceType"] = GetSelectedPerformanceType(),
            ["petAutoCallEnabled"] = PetAutoCallEnabledCheckBox.IsChecked == true,
            ["petAutoGroupEnabled"] = PetAutoGroupEnabledCheckBox.IsChecked == true,
            ["petAutoGroupCommand"] = "/tellpet group",
            ["petDiscoveryEnabled"] = PetDiscoveryEnabledCheckBox.IsChecked == true,
            ["petDiscoveryDebug"] = PetDiscoveryDebugCheckBox.IsChecked == true,
            ["petControlDeviceIds"] = ToJsonArrayFromCommaSeparated(PetControlDeviceIdsTextBox.Text),
            ["petCallRadialId"] = ReadInt(PetCallRadialIdTextBox, "Pet call radial ID", 44),
            ["petCallPauseMs"] = ReadInt(PetCallPauseMsTextBox, "Pet call pause", 3000),
            ["petAutoGroupDelayMs"] = ReadInt(PetAutoGroupDelayMsTextBox, "Pet auto-group delay", 3000),
            ["danceCommand"] = NormalizeText(DanceCommandTextBox.Text),
            ["musicCommand"] = NormalizeText(MusicCommandTextBox.Text),
            ["flourishCommand"] = NormalizeText(FlourishCommandTextBox.Text),
            ["startupCommandPauseMs"] = ReadInt(StartupCommandPauseMsTextBox, "Startup command pause", 3000),
            ["startupDelayMs"] = ReadInt(StartupDelayMsTextBox, "Startup delay", 2500),
            ["intervalMs"] = ReadInt(IntervalMsTextBox, "Loop interval", 3000),
            ["announceCommands"] = AnnounceCommandsCheckBox.IsChecked == true,
            ["autoInviteOnTell"] = AutoInviteOnTellCheckBox.IsChecked == true,
            ["advertsEnabled"] = AdvertsEnabledCheckBox.IsChecked == true,
            ["advertIntervalMs"] = ReadInt(AdvertIntervalMsTextBox, "Advert interval", 120000),
            ["advertChannels"] = ToJsonArrayFromCommaSeparated(AdvertChannelsTextBox.Text),
            ["advertMessage"] = AdvertMessageTextBox.Text ?? string.Empty,
            ["connectionRefreshIntervalMinutes"] = ReadInt(
                ConnectionRefreshIntervalMinutesTextBox,
                "Connection refresh interval",
                30
            ),
            ["connectionTimeoutMs"] = ReadInt(ConnectionTimeoutMsTextBox, "Connection timeout", 10000),
            ["failureThreshold"] = ReadInt(FailureThresholdTextBox, "Failure threshold", 3),
            ["reconnectBaseDelayMs"] = ReadInt(ReconnectBaseDelayMsTextBox, "Reconnect base delay", 5000),
            ["reconnectMaxDelayMs"] = ReadInt(ReconnectMaxDelayMsTextBox, "Reconnect max delay", 60000),
            ["reconnectJitterMs"] = ReadInt(ReconnectJitterMsTextBox, "Reconnect jitter", 1500),
            ["reconnectStableResetMs"] = ReadInt(
                ReconnectStableResetMsTextBox,
                "Reconnect stable reset",
                300000
            ),
            ["verboseSwgLogging"] = VerboseSwgLoggingCheckBox.IsChecked == true
        };

        var bandModeText = BandModeJsonTextBox.Text?.Trim() ?? string.Empty;
        if (!string.IsNullOrWhiteSpace(bandModeText))
        {
            var bandNode = JsonNode.Parse(bandModeText);
            if (bandNode is not JsonArray)
            {
                throw new InvalidOperationException("Band mode JSON must be a JSON array.");
            }

            entBot["entertainers"] = bandNode;
        }

        return new JsonObject
        {
            ["entBot"] = entBot
        };
    }

    private void ApplyDefaultSettings()
    {
        LoginAddressTextBox.Text = "login.swg-starforge.com";
        LoginPortTextBox.Text = "44553";
        UsernameTextBox.Text = string.Empty;
        PasswordBox.Password = string.Empty;
        CharacterTextBox.Text = string.Empty;
        SelectPerformanceType("dance");
        DanceCommandTextBox.Text = "/startdance exotic4";
        MusicCommandTextBox.Text = "/startmusic starwars1";
        FlourishCommandTextBox.Text = "/flourish 2";
        StartupCommandPauseMsTextBox.Text = "3000";
        StartupDelayMsTextBox.Text = "2500";
        IntervalMsTextBox.Text = "3000";
        AnnounceCommandsCheckBox.IsChecked = true;
        AutoInviteOnTellCheckBox.IsChecked = false;
        PetAutoCallEnabledCheckBox.IsChecked = false;
        PetAutoGroupEnabledCheckBox.IsChecked = false;
        PetDiscoveryEnabledCheckBox.IsChecked = true;
        PetDiscoveryDebugCheckBox.IsChecked = false;
        PetControlDeviceIdsTextBox.Text = string.Empty;
        PetCallRadialIdTextBox.Text = "44";
        PetCallPauseMsTextBox.Text = "3000";
        PetAutoGroupDelayMsTextBox.Text = "3000";
        AdvertsEnabledCheckBox.IsChecked = false;
        AdvertIntervalMsTextBox.Text = "120000";
        AdvertChannelsTextBox.Text = "planetSay";
        AdvertMessageTextBox.Text = "Buff service available in Mos Eisley Cantina. Come get your entertainer buffs.";
        ConnectionRefreshIntervalMinutesTextBox.Text = "30";
        ConnectionTimeoutMsTextBox.Text = "10000";
        FailureThresholdTextBox.Text = "3";
        ReconnectBaseDelayMsTextBox.Text = "5000";
        ReconnectMaxDelayMsTextBox.Text = "60000";
        ReconnectJitterMsTextBox.Text = "1500";
        ReconnectStableResetMsTextBox.Text = "300000";
        VerboseSwgLoggingCheckBox.IsChecked = false;
        BandModeJsonTextBox.Text = string.Empty;
    }

    private void ApplySettings(JsonObject root)
    {
        var entBot = root["entBot"] as JsonObject ?? new JsonObject();

        LoginAddressTextBox.Text = GetString(entBot, "loginAddress", "login.swg-starforge.com");
        LoginPortTextBox.Text = GetIntString(entBot, "loginPort", 44553);
        UsernameTextBox.Text = GetString(entBot, "username");
        PasswordBox.Password = GetString(entBot, "password");
        CharacterTextBox.Text = GetString(entBot, "character");
        SelectPerformanceType(GetString(entBot, "performanceType", "dance"));
        DanceCommandTextBox.Text = GetString(entBot, "danceCommand", "/startdance exotic4");
        MusicCommandTextBox.Text = GetString(entBot, "musicCommand", "/startmusic starwars1");
        FlourishCommandTextBox.Text = GetString(entBot, "flourishCommand", "/flourish 2");
        StartupCommandPauseMsTextBox.Text = GetIntString(entBot, "startupCommandPauseMs", 3000);
        StartupDelayMsTextBox.Text = GetIntString(entBot, "startupDelayMs", 2500);
        IntervalMsTextBox.Text = GetIntString(entBot, "intervalMs", 3000);
        AnnounceCommandsCheckBox.IsChecked = GetBool(entBot, "announceCommands", true);
        AutoInviteOnTellCheckBox.IsChecked = GetBool(entBot, "autoInviteOnTell", false);
        PetAutoCallEnabledCheckBox.IsChecked = GetBool(entBot, "petAutoCallEnabled", false);
        PetAutoGroupEnabledCheckBox.IsChecked = GetBool(entBot, "petAutoGroupEnabled", false);
        PetDiscoveryEnabledCheckBox.IsChecked = GetBool(entBot, "petDiscoveryEnabled", true);
        PetDiscoveryDebugCheckBox.IsChecked = GetBool(entBot, "petDiscoveryDebug", false);
        PetControlDeviceIdsTextBox.Text = GetArrayAsCommaSeparated(entBot, "petControlDeviceIds");
        PetCallRadialIdTextBox.Text = GetIntString(entBot, "petCallRadialId", 44);
        PetCallPauseMsTextBox.Text = GetIntString(entBot, "petCallPauseMs", 3000);
        PetAutoGroupDelayMsTextBox.Text = GetIntString(entBot, "petAutoGroupDelayMs", 3000);
        AdvertsEnabledCheckBox.IsChecked = GetBool(entBot, "advertsEnabled", false);
        AdvertIntervalMsTextBox.Text = GetIntString(entBot, "advertIntervalMs", 120000);
        AdvertChannelsTextBox.Text = GetArrayAsCommaSeparated(entBot, "advertChannels", "planetSay");
        AdvertMessageTextBox.Text = GetString(
            entBot,
            "advertMessage",
            "Buff service available in Mos Eisley Cantina. Come get your entertainer buffs."
        );
        ConnectionRefreshIntervalMinutesTextBox.Text = GetIntString(
            entBot,
            "connectionRefreshIntervalMinutes",
            30
        );
        ConnectionTimeoutMsTextBox.Text = GetIntString(entBot, "connectionTimeoutMs", 10000);
        FailureThresholdTextBox.Text = GetIntString(entBot, "failureThreshold", 3);
        ReconnectBaseDelayMsTextBox.Text = GetIntString(entBot, "reconnectBaseDelayMs", 5000);
        ReconnectMaxDelayMsTextBox.Text = GetIntString(entBot, "reconnectMaxDelayMs", 60000);
        ReconnectJitterMsTextBox.Text = GetIntString(entBot, "reconnectJitterMs", 1500);
        ReconnectStableResetMsTextBox.Text = GetIntString(entBot, "reconnectStableResetMs", 300000);
        VerboseSwgLoggingCheckBox.IsChecked = GetBool(entBot, "verboseSwgLogging", false);

        if (entBot["entertainers"] is JsonNode entertainersNode)
        {
            BandModeJsonTextBox.Text = entertainersNode.ToJsonString(_jsonOptions);
        }
        else
        {
            BandModeJsonTextBox.Text = string.Empty;
        }
    }

    private void UpdateUiState()
    {
        StartButton.IsEnabled = !IsBotRunning && !_isStopping;
        StopButton.IsEnabled = IsBotRunning && !_isStopping;
    }

    private void SetStatus(string status)
    {
        StatusTextBlock.Text = $"Status: {status}";
    }

    private void AppendLog(string message)
    {
        if (Dispatcher.CheckAccess())
        {
            AppendLogCore(message);
            return;
        }

        _ = Dispatcher.InvokeAsync(() => AppendLogCore(message));
    }

    private void AppendLogCore(string message)
    {
        if (LogTextBox.Text.Length > 0)
        {
            LogTextBox.AppendText(Environment.NewLine);
        }

        LogTextBox.AppendText(message);
        LogTextBox.ScrollToEnd();
    }

    private static string NormalizeText(string? value)
    {
        return value?.Trim() ?? string.Empty;
    }

    private string[] GetMissingRequiredFields()
    {
        var missingFields = new List<string>();

        if (string.IsNullOrWhiteSpace(LoginAddressTextBox.Text))
        {
            missingFields.Add("Login Address");
        }

        if (string.IsNullOrWhiteSpace(LoginPortTextBox.Text))
        {
            missingFields.Add("Login Port");
        }

        if (string.IsNullOrWhiteSpace(UsernameTextBox.Text))
        {
            missingFields.Add("Username");
        }

        if (string.IsNullOrWhiteSpace(PasswordBox.Password))
        {
            missingFields.Add("Password");
        }

        if (string.IsNullOrWhiteSpace(CharacterTextBox.Text))
        {
            missingFields.Add("Character");
        }

        return missingFields.ToArray();
    }

    private string ResolveNodeExecutablePath()
    {
        var candidatePaths = new[]
        {
            Path.Combine(_bundledNodeDirectory, "node.exe"),
            Path.Combine(AppContext.BaseDirectory, "node.exe")
        };

        foreach (var candidatePath in candidatePaths)
        {
            if (File.Exists(candidatePath))
            {
                return candidatePath;
            }
        }

        return "node";
    }

    private static int ReadInt(TextBox textBox, string fieldName, int fallback)
    {
        var raw = textBox.Text?.Trim() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(raw))
        {
            return fallback;
        }

        if (!int.TryParse(raw, out var parsed))
        {
            throw new InvalidOperationException($"{fieldName} must be a whole number.");
        }

        return parsed;
    }

    private static JsonArray ToJsonArrayFromCommaSeparated(string? value)
    {
        var array = new JsonArray();
        foreach (var entry in (value ?? string.Empty)
                     .Split(',', StringSplitOptions.RemoveEmptyEntries)
                     .Select(line => line.Trim())
                     .Where(line => !string.IsNullOrWhiteSpace(line)))
        {
            array.Add(entry);
        }

        return array;
    }

    private void SelectPerformanceType(string value)
    {
        foreach (var item in PerformanceTypeComboBox.Items.OfType<ComboBoxItem>())
        {
            if (string.Equals(item.Content?.ToString(), value, StringComparison.OrdinalIgnoreCase))
            {
                PerformanceTypeComboBox.SelectedItem = item;
                return;
            }
        }

        PerformanceTypeComboBox.SelectedIndex = 0;
    }

    private string GetSelectedPerformanceType()
    {
        return (PerformanceTypeComboBox.SelectedItem as ComboBoxItem)?.Content?.ToString()?.Trim().ToLowerInvariant()
            ?? "dance";
    }

    private static string GetString(JsonObject source, string propertyName, string fallback = "")
    {
        try
        {
            return source[propertyName]?.GetValue<string>() ?? fallback;
        }
        catch
        {
            return fallback;
        }
    }

    private static bool GetBool(JsonObject source, string propertyName, bool fallback)
    {
        try
        {
            return source[propertyName]?.GetValue<bool>() ?? fallback;
        }
        catch
        {
            return fallback;
        }
    }

    private static string GetIntString(JsonObject source, string propertyName, int fallback)
    {
        try
        {
            return source[propertyName]?.GetValue<int>().ToString() ?? fallback.ToString();
        }
        catch
        {
            return fallback.ToString();
        }
    }

    private static string GetArrayAsCommaSeparated(JsonObject source, string propertyName, string fallback = "")
    {
        if (source[propertyName] is not JsonArray array || array.Count == 0)
        {
            return fallback;
        }

        return string.Join(", ", array.Select(GetNodeText).Where(value => !string.IsNullOrWhiteSpace(value)));
    }

    private static string GetNodeText(JsonNode? node)
    {
        if (node is null)
        {
            return string.Empty;
        }

        try
        {
            return node.GetValue<string>();
        }
        catch
        {
            var raw = node.ToJsonString();
            if (raw.Length >= 2 && raw.StartsWith('"') && raw.EndsWith('"'))
            {
                try
                {
                    return JsonSerializer.Deserialize<string>(raw) ?? string.Empty;
                }
                catch
                {
                    return raw.Trim('"');
                }
            }

            return raw;
        }
    }
}
