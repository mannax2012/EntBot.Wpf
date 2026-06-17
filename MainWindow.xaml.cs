using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;

namespace EntBot.Wpf;

public partial class MainWindow : Window
{
    private const string WorkerSettingsEnvVar = "ENTBOT_WPF_SETTINGS_FILE";
    private const string WorkerAutoStartEnvVar = "ENTBOT_WPF_AUTO_START";
    private const string WorkerModeEnvVar = "ENTBOT_WPF_WORKER";
    private const string WorkerLogEnvVar = "ENTBOT_WPF_WORKER_LOG_FILE";
    private const int DefaultPetCallRadialId = 44;
    private const int DefaultLoopIntervalMs = 3000;
    private const string DefaultDanceSelection = "exotic4";
    private const string DefaultMusicSelection = "starwars1";
    private const string DefaultFlourishSelection = "2";
    private readonly string _settingsPath;
    private readonly string _updateSettingsPath = Path.Combine(AppContext.BaseDirectory, "update-settings.json");
    private readonly string _localVersionManifestPath = Path.Combine(AppContext.BaseDirectory, "version.json");
    private readonly string _botDirectory = Path.Combine(AppContext.BaseDirectory, "bot");
    private readonly string _bundledNodeDirectory = Path.Combine(AppContext.BaseDirectory, "runtime", "node");
    private readonly string _updaterDirectory = Path.Combine(AppContext.BaseDirectory, "updater");
    private readonly JsonSerializerOptions _jsonOptions = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
        TypeInfoResolver = new DefaultJsonTypeInfoResolver()
    };
    private static readonly HttpClient UpdateHttpClient = new() { Timeout = TimeSpan.FromMinutes(5) };
    private Process? _botProcess;
    private readonly List<Process> _botProcesses = new();
    private readonly List<string> _workerSettingsPaths = new();
    private readonly List<string> _workerLogPaths = new();
    private readonly List<WorkerLogState> _workerLogStates = new();
    private readonly DispatcherTimer _workerLogPollTimer = new() { Interval = TimeSpan.FromMilliseconds(500) };
    private readonly string? _workerLogPath;
    private readonly object _workerLogSync = new();
    private readonly bool _isWorkerInstance;
    private readonly bool _autoStartWorkerInstance;
    private bool _isStopping;
    private bool _isCheckingForUpdates;
    private bool _isApplyingUpdate;
    private bool _usingExternalAppWorkers;
    private int _pendingBandModeSelectionIndex = -1;
    private bool _isEditingNewBandMember = true;

    public MainWindow()
    {
        _settingsPath = Environment.GetEnvironmentVariable(WorkerSettingsEnvVar)
            ?.Trim() is { Length: > 0 } overridePath
            ? overridePath
            : Path.Combine(AppContext.BaseDirectory, "bot-settings.json");
        _workerLogPath = Environment.GetEnvironmentVariable(WorkerLogEnvVar)?.Trim();
        _isWorkerInstance = string.Equals(Environment.GetEnvironmentVariable(WorkerModeEnvVar), "1", StringComparison.Ordinal);
        _autoStartWorkerInstance = string.Equals(Environment.GetEnvironmentVariable(WorkerAutoStartEnvVar), "1", StringComparison.Ordinal);
        InitializeComponent();
        _workerLogPollTimer.Tick += WorkerLogPollTimer_OnTick;
        ApplyDefaultSettings();
        LoadSettingsFromDisk();
        RefreshVersionText();
        UpdateUiState();
    }

    private bool IsBotRunning => _botProcesses.Any(process => !process.HasExited);

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

    private void ReplaceBandModeWithCurrentButton_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            var entertainers = ParseBandModeJsonArrayOrEmpty();
            var selectedIndex = BandModeListBox.SelectedIndex;
            if (selectedIndex >= 0 && selectedIndex < entertainers.Count)
            {
                entertainers[selectedIndex] = BuildCurrentEntertainerJson();
                SetBandModeJson(entertainers, selectedIndex);
                AppendLog("[App] Selected band entertainer replaced with the current settings.");
                return;
            }

            entertainers.Clear();
            entertainers.Add(BuildCurrentEntertainerJson());
            SetBandModeJson(entertainers, 0);
            AppendLog("[App] Band roster restarted with the current entertainer settings.");
        }
        catch (Exception ex)
        {
            ShowBandModeError(ex.Message);
        }
    }

    private void AddCurrentEntertainerButton_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            var entertainers = ParseBandModeJsonArrayOrEmpty();
            entertainers.Add(BuildCurrentEntertainerJson());
            SetBandModeJson(entertainers, entertainers.Count - 1);
            AppendLog("[App] Current entertainer settings added to the band roster.");
        }
        catch (Exception ex)
        {
            ShowBandModeError(ex.Message);
        }
    }

    private void InsertBandModeTemplateButton_OnClick(object sender, RoutedEventArgs e)
    {
        var entertainers = BuildBandModeTemplateArray();
        SetBandModeJson(entertainers, 0);
        AppendLog("[App] Band mode template inserted.");
    }

    private void FormatBandModeJsonButton_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            var entertainers = ParseBandModeJsonArrayOrEmpty();
            SetBandModeJson(entertainers, BandModeListBox.SelectedIndex);
            AppendLog("[App] Band mode JSON formatted.");
        }
        catch (Exception ex)
        {
            ShowBandModeError(ex.Message);
        }
    }

    private void LoadSelectedBandMemberButton_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            var entertainer = GetSelectedBandEntertainer();
            if (entertainer is null)
            {
                AppendLog("[App] Select a band entertainer first.");
                return;
            }

            ApplyEntertainerToMainForm(entertainer);
            AppendLog("[App] Selected band entertainer loaded into the main settings tabs.");
        }
        catch (Exception ex)
        {
            ShowBandModeError(ex.Message);
        }
    }

    private void RemoveSelectedBandMemberButton_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            var entertainers = ParseBandModeJsonArrayOrEmpty();
            var selectedIndex = BandModeListBox.SelectedIndex;
            if (selectedIndex < 0 || selectedIndex >= entertainers.Count)
            {
                AppendLog("[App] Select a band entertainer to remove.");
                return;
            }

            entertainers.RemoveAt(selectedIndex);
            var nextIndex = entertainers.Count == 0 ? -1 : Math.Min(selectedIndex, entertainers.Count - 1);
            SetBandModeJson(entertainers, nextIndex);
            AppendLog("[App] Selected band entertainer removed.");
        }
        catch (Exception ex)
        {
            ShowBandModeError(ex.Message);
        }
    }

    private void MoveBandMemberUpButton_OnClick(object sender, RoutedEventArgs e)
    {
        MoveSelectedBandMember(-1);
    }

    private void MoveBandMemberDownButton_OnClick(object sender, RoutedEventArgs e)
    {
        MoveSelectedBandMember(1);
    }

    private void AddBandEditorMemberButton_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            var entertainers = ParseBandModeJsonArrayOrEmpty();
            entertainers.Add(BuildBandEditorEntertainerJson());
            _isEditingNewBandMember = false;
            SetBandModeJson(entertainers, entertainers.Count - 1);
            AppendLog("[App] Band editor entry added to the roster.");
        }
        catch (Exception ex)
        {
            ShowBandModeError(ex.Message);
        }
    }

    private void SaveSelectedBandMemberButton_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            var entertainers = ParseBandModeJsonArrayOrEmpty();
            var selectedIndex = BandModeListBox.SelectedIndex;
            if (selectedIndex < 0 || selectedIndex >= entertainers.Count)
            {
                AppendLog("[App] Select a band entertainer to save changes to, or use Add As New.");
                return;
            }

            var existing = entertainers[selectedIndex] as JsonObject;
            entertainers[selectedIndex] = BuildBandEditorEntertainerJson(existing);
            _isEditingNewBandMember = false;
            SetBandModeJson(entertainers, selectedIndex);
            AppendLog("[App] Selected band entertainer updated from the band editor.");
        }
        catch (Exception ex)
        {
            ShowBandModeError(ex.Message);
        }
    }

    private void NewBandEditorButton_OnClick(object sender, RoutedEventArgs e)
    {
        _isEditingNewBandMember = true;
        if (BandModeListBox is not null)
        {
            BandModeListBox.SelectedIndex = -1;
        }

        PopulateBandEditorFromEntertainer(null);
        UpdateUiState();
        AppendLog("[App] Band editor reset for a new roster entry.");
    }

    private void ApplyBandEditorToMainButton_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            ApplyEntertainerToMainForm(BuildBandEditorEntertainerJson());
            AppendLog("[App] Band editor values loaded into the main settings tabs.");
        }
        catch (Exception ex)
        {
            ShowBandModeError(ex.Message);
        }
    }

    private async void CheckUpdatesButton_OnClick(object sender, RoutedEventArgs e)
    {
        await CheckForUpdatesAsync(userInitiated: true);
    }

    private async void MainWindow_OnLoaded(object sender, RoutedEventArgs e)
    {
        if (_isWorkerInstance)
        {
            ShowInTaskbar = false;
            WindowState = WindowState.Minimized;
            Hide();
        }

        if (!_isWorkerInstance)
        {
            await MaybeCheckForUpdatesOnStartupAsync();
        }

        if (_autoStartWorkerInstance)
        {
            StartButton_OnClick(this, new RoutedEventArgs());
        }

        RefreshWindowStateUi();
    }

    private void MainWindow_OnStateChanged(object? sender, EventArgs e)
    {
        RefreshWindowStateUi();
    }

    private void TitleBar_OnMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ChangedButton != MouseButton.Left)
        {
            return;
        }

        if (e.ClickCount == 2)
        {
            ToggleWindowState();
            return;
        }

        try
        {
            DragMove();
        }
        catch
        {
            // ignore drag gesture failures
        }
    }

    private void MinimizeButton_OnClick(object sender, RoutedEventArgs e)
    {
        WindowState = WindowState.Minimized;
    }

    private void MaximizeRestoreButton_OnClick(object sender, RoutedEventArgs e)
    {
        ToggleWindowState();
    }

    private void CloseButton_OnClick(object sender, RoutedEventArgs e)
    {
        Close();
    }

    private async void StartButton_OnClick(object sender, RoutedEventArgs e)
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

        try
        {
            var nodeExecutablePath = ResolveNodeExecutablePath();
            var bandProcesses = BuildBandProcessSettings();
            ClearWorkerSettingsFiles();

            if (bandProcesses.Count > 1)
            {
                await StartBandProcessesAsync(nodeExecutablePath, bandProcesses);
                return;
            }

            StartBotProcess(nodeExecutablePath, _settingsPath);
        }
        catch (Exception ex)
        {
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
        var processes = _botProcesses.Where(process => !process.HasExited).ToList();
        if (processes.Count == 0 || _isStopping)
        {
            return;
        }

        _isStopping = true;
        SetStatus("Stopping");
        UpdateUiState();
        AppendLog("[App] Sending shutdown command to the bot.");

        if (_usingExternalAppWorkers)
        {
            foreach (var process in processes)
            {
                try
                {
                    if (!process.CloseMainWindow())
                    {
                        process.Kill(true);
                    }
                }
                catch (Exception ex)
                {
                    AppendLog($"[App] Could not stop worker app: {ex.Message}");
                }
            }
        }
        else
        {
            foreach (var process in processes)
            {
                try
                {
                    process.StandardInput.WriteLine("shutdown");
                    process.StandardInput.Flush();
                }
                catch (Exception ex)
                {
                    AppendLog($"[App] Could not send shutdown command: {ex.Message}");
                }
            }
        }

        try
        {
            var waitForExitTask = Task.WhenAll(processes.Select(process => process.WaitForExitAsync()));
            var completedTask = await Task.WhenAny(waitForExitTask, Task.Delay(5000));
            if (completedTask == waitForExitTask)
            {
                await waitForExitTask;
                return;
            }

            AppendLog("[App] Graceful shutdown timed out. Terminating process.");

            foreach (var process in processes)
            {
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
        }
        finally
        {
            if (_botProcesses.All(process => process.HasExited))
            {
                _botProcesses.Clear();
                _botProcess = null;
                _usingExternalAppWorkers = false;
                ClearWorkerSettingsFiles();
                ClearWorkerLogFiles();
                _isStopping = false;
                SetStatus("Stopped");
                UpdateUiState();
            }
        }
    }

    private void MainWindow_OnClosing(object? sender, CancelEventArgs e)
    {
        if (_isApplyingUpdate || _isStopping)
        {
            return;
        }

        var processes = _botProcesses.Where(process => !process.HasExited).ToList();
        if (processes.Count == 0)
        {
            return;
        }

        foreach (var process in processes)
        {
            if (_usingExternalAppWorkers)
            {
                try
                {
                    if (!process.CloseMainWindow())
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
            else
            {
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
        }

        _usingExternalAppWorkers = false;
        ClearWorkerSettingsFiles();
        ClearWorkerLogFiles();
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
            ["petCallRadialId"] = DefaultPetCallRadialId,
            ["petCallPauseMs"] = ReadMillisecondsFromSeconds(PetCallPauseMsTextBox, "Pet call pause", 3000),
            ["petAutoGroupDelayMs"] = ReadMillisecondsFromSeconds(PetAutoGroupDelayMsTextBox, "Pet auto-group delay", 3000),
            ["danceCommand"] = BuildDanceCommand(),
            ["musicCommand"] = BuildMusicCommand(),
            ["startupCommandPauseMs"] = ReadMillisecondsFromSeconds(
                StartupCommandPauseMsTextBox,
                "Startup command pause",
                3000
            ),
            ["startupDelayMs"] = ReadMillisecondsFromSeconds(StartupDelayMsTextBox, "Startup delay", 2500),
            ["intervalMs"] = DefaultLoopIntervalMs,
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

        var flourishCommand = BuildFlourishCommand();
        if (!string.IsNullOrWhiteSpace(flourishCommand))
        {
            entBot["flourishCommand"] = flourishCommand;
        }

        var bandModeText = BandModeJsonTextBox.Text?.Trim() ?? string.Empty;
        if (BandModeEnabledCheckBox.IsChecked == true && !string.IsNullOrWhiteSpace(bandModeText))
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
            ["entBot"] = entBot,
            ["entBotWpf"] = new JsonObject
            {
                ["bandModeEnabled"] = BandModeEnabledCheckBox.IsChecked == true,
                ["bandModeDraft"] = bandModeText,
                ["specificFlourishEnabled"] = SpecificFlourishEnabledCheckBox.IsChecked == true,
                ["specificFlourishNumber"] = GetSelectedComboBoxTag(FlourishCommandComboBox, DefaultFlourishSelection)
            }
        };
    }

    private JsonObject BuildCurrentEntertainerJson()
    {
        var entertainer = new JsonObject
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
            ["petCallRadialId"] = DefaultPetCallRadialId,
            ["petCallPauseMs"] = ReadMillisecondsFromSeconds(PetCallPauseMsTextBox, "Pet call pause", 3000),
            ["petAutoGroupDelayMs"] = ReadMillisecondsFromSeconds(PetAutoGroupDelayMsTextBox, "Pet auto-group delay", 3000),
            ["danceCommand"] = BuildDanceCommand(),
            ["musicCommand"] = BuildMusicCommand(),
            ["startupCommandPauseMs"] = ReadMillisecondsFromSeconds(
                StartupCommandPauseMsTextBox,
                "Startup command pause",
                3000
            ),
            ["startupDelayMs"] = ReadMillisecondsFromSeconds(StartupDelayMsTextBox, "Startup delay", 2500),
            ["intervalMs"] = DefaultLoopIntervalMs,
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

        var flourishCommand = BuildFlourishCommand();
        if (!string.IsNullOrWhiteSpace(flourishCommand))
        {
            entertainer["flourishCommand"] = flourishCommand;
        }

        return entertainer;
    }

    private List<JsonObject> BuildBandProcessSettings()
    {
        if (BandModeEnabledCheckBox.IsChecked != true)
        {
            return new List<JsonObject>();
        }

        return ParseBandModeJsonArrayOrEmpty()
            .OfType<JsonObject>()
            .Select(node => node.DeepClone() as JsonObject ?? new JsonObject())
            .Where(node => !string.IsNullOrWhiteSpace(GetString(node, "character")))
            .ToList();
    }

    private JsonArray ParseBandModeJsonArrayOrEmpty()
    {
        var raw = BandModeJsonTextBox.Text?.Trim() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(raw))
        {
            return new JsonArray();
        }

        var node = JsonNode.Parse(raw);
        if (node is not JsonArray entertainers)
        {
            throw new InvalidOperationException("Band mode JSON must be a JSON array.");
        }

        return entertainers;
    }

    private JsonArray BuildBandModeTemplateArray()
    {
        return new JsonArray
        {
            new JsonObject
            {
                ["character"] = "EntertainerOne",
                ["username"] = "accountName",
                ["password"] = "password",
                ["performanceType"] = "dance",
                ["danceCommand"] = "/startdance exotic4",
                ["musicCommand"] = "/startmusic starwars1",
                ["startupDelayMs"] = 2500,
                ["startupCommandPauseMs"] = 3000,
                ["intervalMs"] = DefaultLoopIntervalMs,
                ["announceCommands"] = true,
                ["autoInviteOnTell"] = false,
                ["petAutoCallEnabled"] = false,
                ["petAutoGroupEnabled"] = false,
                ["petControlDeviceIds"] = new JsonArray(),
                ["advertsEnabled"] = false
            }
        };
    }

    private void SetBandModeJson(JsonArray entertainers, int selectedIndex)
    {
        _pendingBandModeSelectionIndex = selectedIndex;
        BandModeJsonTextBox.Text = entertainers.ToJsonString(_jsonOptions);
    }

    private void ShowBandModeError(string message)
    {
        AppendLog($"[App] Band mode helper failed: {message}");
        MessageBox.Show(
            this,
            message,
            "Band Mode JSON",
            MessageBoxButton.OK,
            MessageBoxImage.Warning
        );
    }

    private void RefreshBandModeEditorUi()
    {
        if (BandModeListBox is null || BandModeStatusTextBlock is null)
        {
            return;
        }

        var requestedIndex = _pendingBandModeSelectionIndex >= 0
            ? _pendingBandModeSelectionIndex
            : BandModeListBox.SelectedIndex;
        _pendingBandModeSelectionIndex = -1;

        BandModeListBox.Items.Clear();

        try
        {
            var entertainers = ParseBandModeJsonArrayOrEmpty();
            for (var index = 0; index < entertainers.Count; index += 1)
            {
                BandModeListBox.Items.Add(BuildBandModeListLabel(entertainers[index], index));
            }

            if (entertainers.Count == 0)
            {
                BandModeStatusTextBlock.Text = "No band entertainers configured yet.";
                BandModeListBox.SelectedIndex = -1;
                _isEditingNewBandMember = true;
            }
            else
            {
                BandModeStatusTextBlock.Text = entertainers.Count == 1
                    ? "1 entertainer ready for band mode."
                    : $"{entertainers.Count} entertainers ready for band mode.";

                if (_isEditingNewBandMember && requestedIndex < 0)
                {
                    BandModeListBox.SelectedIndex = -1;
                }
                else
                {
                    var clampedIndex = Math.Max(0, Math.Min(requestedIndex, entertainers.Count - 1));
                    BandModeListBox.SelectedIndex = clampedIndex;
                }
            }
        }
        catch (Exception ex)
        {
            BandModeStatusTextBlock.Text = $"JSON needs attention: {ex.Message}";
            _isEditingNewBandMember = true;
        }

        RefreshBandModeSelectionDetails();
        UpdateUiState();
    }

    private void RefreshBandModeSelectionDetails()
    {
        if (BandModeEditorStatusTextBlock is null)
        {
            return;
        }

        try
        {
            var entertainer = GetSelectedBandEntertainer();
            if (entertainer is null)
            {
                PopulateBandEditorFromEntertainer(null);
                BandModeEditorStatusTextBlock.Text = "Create a new band member here, or select one from the roster to edit it.";
                UpdateUiState();
                return;
            }

            PopulateBandEditorFromEntertainer(entertainer);
            BandModeEditorStatusTextBlock.Text =
                $"Editing entertainer #{BandModeListBox.SelectedIndex + 1}. Save Selected to update this roster slot.";
        }
        catch
        {
            PopulateBandEditorFromEntertainer(null);
            BandModeEditorStatusTextBlock.Text = "Band editor is unavailable until the roster data is valid again.";
        }

        UpdateUiState();
    }

    private JsonObject? GetSelectedBandEntertainer()
    {
        var entertainers = ParseBandModeJsonArrayOrEmpty();
        var selectedIndex = BandModeListBox.SelectedIndex;
        if (selectedIndex < 0 || selectedIndex >= entertainers.Count)
        {
            return null;
        }

        return entertainers[selectedIndex] as JsonObject;
    }

    private JsonObject BuildBandEditorEntertainerJson(JsonObject? existing = null)
    {
        var entertainer = existing?.DeepClone() as JsonObject ?? BuildCurrentEntertainerJson();
        entertainer["username"] = NormalizeText(BandUsernameTextBox.Text);
        entertainer["password"] = BandPasswordTextBox.Text ?? string.Empty;
        entertainer["character"] = NormalizeText(BandCharacterTextBox.Text);
        entertainer["performanceType"] = GetSelectedBandPerformanceType();
        entertainer["danceCommand"] = BuildBandDanceCommand();
        entertainer["musicCommand"] = BuildBandMusicCommand();
        entertainer["petAutoCallEnabled"] = BandPetAutoCallEnabledCheckBox.IsChecked == true;
        entertainer["petAutoGroupEnabled"] = BandPetAutoGroupEnabledCheckBox.IsChecked == true;
        entertainer["petAutoGroupCommand"] = "/tellpet group";
        entertainer["autoInviteOnTell"] = BandAutoInviteOnTellCheckBox.IsChecked == true;
        entertainer["petControlDeviceIds"] = ToJsonArrayFromCommaSeparated(BandPetControlDeviceIdsTextBox.Text);
        entertainer["advertsEnabled"] = BandAdvertsEnabledCheckBox.IsChecked == true;

        var flourishCommand = BuildBandFlourishCommand();
        if (!string.IsNullOrWhiteSpace(flourishCommand))
        {
            entertainer["flourishCommand"] = flourishCommand;
        }
        else
        {
            entertainer.Remove("flourishCommand");
        }

        return entertainer;
    }

    private void PopulateBandEditorFromEntertainer(JsonObject? entertainer)
    {
        if (BandCharacterTextBox is null)
        {
            return;
        }

        var source = entertainer ?? BuildCurrentEntertainerJson();
        BandCharacterTextBox.Text = GetString(source, "character");
        BandUsernameTextBox.Text = GetString(source, "username");
        BandPasswordTextBox.Text = GetString(source, "password");
        SelectBandPerformanceType(GetString(source, "performanceType", "dance"));
        SelectComboBoxItemByTag(
            BandDanceCommandComboBox,
            ExtractCommandSelection(GetString(source, "danceCommand", "/startdance exotic4"), "/startdance", DefaultDanceSelection)
        );
        SelectComboBoxItemByTag(
            BandMusicCommandComboBox,
            ExtractCommandSelection(GetString(source, "musicCommand", "/startmusic starwars1"), "/startmusic", DefaultMusicSelection)
        );

        var flourishSelection = ExtractFlourishSelection(GetString(source, "flourishCommand"));
        BandSpecificFlourishEnabledCheckBox.IsChecked = !string.IsNullOrWhiteSpace(flourishSelection);
        SelectComboBoxItemByTag(
            BandFlourishCommandComboBox,
            flourishSelection ?? DefaultFlourishSelection
        );
        UpdateBandEditorFlourishUiState();

        BandPetAutoCallEnabledCheckBox.IsChecked = GetBool(source, "petAutoCallEnabled", false);
        BandPetAutoGroupEnabledCheckBox.IsChecked = GetBool(source, "petAutoGroupEnabled", false);
        BandAutoInviteOnTellCheckBox.IsChecked = GetBool(source, "autoInviteOnTell", false);
        BandAdvertsEnabledCheckBox.IsChecked = GetBool(source, "advertsEnabled", false);
        BandPetControlDeviceIdsTextBox.Text = GetArrayAsCommaSeparated(source, "petControlDeviceIds");
    }

    private void ApplyEntertainerToMainForm(JsonObject entertainer)
    {
        var bandModeDraft = BandModeJsonTextBox.Text?.Trim() ?? string.Empty;
        var flourishSelection = ExtractFlourishSelection(GetString(entertainer, "flourishCommand"));
        var wrapper = new JsonObject
        {
            ["entBot"] = entertainer.DeepClone(),
            ["entBotWpf"] = new JsonObject
            {
                ["bandModeEnabled"] = BandModeEnabledCheckBox.IsChecked == true,
                ["bandModeDraft"] = bandModeDraft,
                ["specificFlourishEnabled"] = !string.IsNullOrWhiteSpace(flourishSelection),
                ["specificFlourishNumber"] = flourishSelection ?? DefaultFlourishSelection
            }
        };

        ApplySettings(wrapper);
        RefreshBandModeEditorUi();
    }

    private void MoveSelectedBandMember(int direction)
    {
        try
        {
            var entertainers = ParseBandModeJsonArrayOrEmpty();
            var selectedIndex = BandModeListBox.SelectedIndex;
            var targetIndex = selectedIndex + direction;
            if (selectedIndex < 0 || selectedIndex >= entertainers.Count || targetIndex < 0 || targetIndex >= entertainers.Count)
            {
                AppendLog("[App] Select a band entertainer that can be moved.");
                return;
            }

            (entertainers[selectedIndex], entertainers[targetIndex]) = (entertainers[targetIndex], entertainers[selectedIndex]);
            _isEditingNewBandMember = false;
            SetBandModeJson(entertainers, targetIndex);
            AppendLog("[App] Band entertainer order updated.");
        }
        catch (Exception ex)
        {
            ShowBandModeError(ex.Message);
        }
    }

    private void ApplyDefaultSettings()
    {
        LoginAddressTextBox.Text = "login.swg-starforge.com";
        LoginPortTextBox.Text = "44553";
        UsernameTextBox.Text = string.Empty;
        PasswordBox.Password = string.Empty;
        CharacterTextBox.Text = string.Empty;
        SelectPerformanceType("dance");
        SelectComboBoxItemByTag(DanceCommandComboBox, DefaultDanceSelection);
        SelectComboBoxItemByTag(MusicCommandComboBox, DefaultMusicSelection);
        SpecificFlourishEnabledCheckBox.IsChecked = false;
        SelectComboBoxItemByTag(FlourishCommandComboBox, DefaultFlourishSelection);
        UpdateFlourishUiState();
        StartupCommandPauseMsTextBox.Text = "3";
        StartupDelayMsTextBox.Text = "2.5";
        AnnounceCommandsCheckBox.IsChecked = true;
        AutoInviteOnTellCheckBox.IsChecked = false;
        PetAutoCallEnabledCheckBox.IsChecked = false;
        PetAutoGroupEnabledCheckBox.IsChecked = false;
        PetDiscoveryEnabledCheckBox.IsChecked = true;
        PetDiscoveryDebugCheckBox.IsChecked = false;
        PetControlDeviceIdsTextBox.Text = string.Empty;
        PetCallPauseMsTextBox.Text = "3";
        PetAutoGroupDelayMsTextBox.Text = "3";
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
        BandModeEnabledCheckBox.IsChecked = false;
        BandModeJsonTextBox.Text = string.Empty;
        RefreshBandModeEditorUi();
    }

    private void ApplySettings(JsonObject root)
    {
        var entBot = root["entBot"] as JsonObject ?? new JsonObject();
        var entBotWpf = root["entBotWpf"] as JsonObject ?? new JsonObject();

        LoginAddressTextBox.Text = GetString(entBot, "loginAddress", "login.swg-starforge.com");
        LoginPortTextBox.Text = GetIntString(entBot, "loginPort", 44553);
        UsernameTextBox.Text = GetString(entBot, "username");
        PasswordBox.Password = GetString(entBot, "password");
        CharacterTextBox.Text = GetString(entBot, "character");
        SelectPerformanceType(GetString(entBot, "performanceType", "dance"));
        SelectComboBoxItemByTag(
            DanceCommandComboBox,
            ExtractCommandSelection(GetString(entBot, "danceCommand", "/startdance exotic4"), "/startdance", DefaultDanceSelection)
        );
        SelectComboBoxItemByTag(
            MusicCommandComboBox,
            ExtractCommandSelection(GetString(entBot, "musicCommand", "/startmusic starwars1"), "/startmusic", DefaultMusicSelection)
        );
        var flourishSelection = ExtractFlourishSelection(GetString(entBot, "flourishCommand"));
        if (!string.IsNullOrWhiteSpace(flourishSelection))
        {
            SpecificFlourishEnabledCheckBox.IsChecked = true;
            SelectComboBoxItemByTag(FlourishCommandComboBox, flourishSelection);
        }
        else
        {
            SpecificFlourishEnabledCheckBox.IsChecked = GetBool(entBotWpf, "specificFlourishEnabled", false);
            SelectComboBoxItemByTag(
                FlourishCommandComboBox,
                GetString(entBotWpf, "specificFlourishNumber", DefaultFlourishSelection)
            );
        }

        StartupCommandPauseMsTextBox.Text = GetSecondsString(entBot, "startupCommandPauseMs", 3000);
        StartupDelayMsTextBox.Text = GetSecondsString(entBot, "startupDelayMs", 2500);
        AnnounceCommandsCheckBox.IsChecked = GetBool(entBot, "announceCommands", true);
        AutoInviteOnTellCheckBox.IsChecked = GetBool(entBot, "autoInviteOnTell", false);
        PetAutoCallEnabledCheckBox.IsChecked = GetBool(entBot, "petAutoCallEnabled", false);
        PetAutoGroupEnabledCheckBox.IsChecked = GetBool(entBot, "petAutoGroupEnabled", false);
        PetDiscoveryEnabledCheckBox.IsChecked = GetBool(entBot, "petDiscoveryEnabled", true);
        PetDiscoveryDebugCheckBox.IsChecked = GetBool(entBot, "petDiscoveryDebug", false);
        PetControlDeviceIdsTextBox.Text = GetArrayAsCommaSeparated(entBot, "petControlDeviceIds");
        PetCallPauseMsTextBox.Text = GetSecondsString(entBot, "petCallPauseMs", 3000);
        PetAutoGroupDelayMsTextBox.Text = GetSecondsString(entBot, "petAutoGroupDelayMs", 3000);
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
            BandModeEnabledCheckBox.IsChecked = true;
            BandModeJsonTextBox.Text = entertainersNode.ToJsonString(_jsonOptions);
        }
        else
        {
            BandModeEnabledCheckBox.IsChecked = GetBool(entBotWpf, "bandModeEnabled", false);
            BandModeJsonTextBox.Text = GetString(entBotWpf, "bandModeDraft");
        }

        UpdateFlourishUiState();
        RefreshBandModeEditorUi();
    }

    private async Task MaybeCheckForUpdatesOnStartupAsync()
    {
        try
        {
            var updateSettings = LoadUpdateSettings();
            if (!updateSettings.CheckOnStartup || string.IsNullOrWhiteSpace(updateSettings.VersionManifestUrl))
            {
                return;
            }

            await CheckForUpdatesAsync(userInitiated: false);
        }
        catch (Exception ex)
        {
            AppendLog($"[Update] Startup update check skipped: {ex.Message}");
        }
    }

    private async Task CheckForUpdatesAsync(bool userInitiated)
    {
        if (_isCheckingForUpdates || _isApplyingUpdate)
        {
            return;
        }

        _isCheckingForUpdates = true;
        SetStatus("Checking for Updates");
        UpdateUiState();

        try
        {
            var updateSettings = LoadUpdateSettings();
            if (string.IsNullOrWhiteSpace(updateSettings.VersionManifestUrl))
            {
                const string message = "Set versionManifestUrl in update-settings.json before checking for updates.";
                AppendLog($"[Update] {message}");

                if (userInitiated)
                {
                    MessageBox.Show(
                        this,
                        message,
                        "Update Source Not Configured",
                        MessageBoxButton.OK,
                        MessageBoxImage.Information
                    );
                }

                return;
            }

            AppendLog("[Update] Checking for updates....");
            var remoteManifest = await DownloadUpdateManifestAsync(updateSettings.VersionManifestUrl);
            var currentVersion = GetCurrentVersion();
            var remoteVersion = ParseVersion(remoteManifest.Version);

            AppendLog($"[Update] Current version: {currentVersion}");
            AppendLog($"[Update] Remote version: {remoteVersion}");

            if (remoteVersion.CompareTo(currentVersion) <= 0)
            {
                AppendLog("[Update] You are already up to date.");
                return;
            }

            var prompt = $"A new version is available.\n\nCurrent: {currentVersion}\nLatest: {remoteVersion}\n\nDownload and install now?";
            if (MessageBox.Show(
                    this,
                    prompt,
                    "Update Available",
                    MessageBoxButton.YesNo,
                    MessageBoxImage.Question) != MessageBoxResult.Yes)
            {
                AppendLog("[Update] Update install canceled by user.");
                return;
            }

            await BeginUpdateInstallAsync(remoteManifest);
        }
        catch (Exception ex)
        {
            AppendLog($"[Update] Update check failed: {ex.Message}");
            if (userInitiated)
            {
                MessageBox.Show(
                    this,
                    ex.Message,
                    "Update Check Failed",
                    MessageBoxButton.OK,
                    MessageBoxImage.Error
                );
            }
        }
        finally
        {
            if (!_isApplyingUpdate)
            {
                SetStatus(IsBotRunning ? "Running" : "Idle");
            }

            _isCheckingForUpdates = false;
            UpdateUiState();
        }
    }

    private UpdateSettings LoadUpdateSettings()
    {
        if (!File.Exists(_updateSettingsPath))
        {
            return new UpdateSettings();
        }

        var json = File.ReadAllText(_updateSettingsPath);
        return JsonSerializer.Deserialize<UpdateSettings>(json, _jsonOptions) ?? new UpdateSettings();
    }

    private UpdateManifest LoadLocalVersionManifest()
    {
        if (!File.Exists(_localVersionManifestPath))
        {
            return new UpdateManifest { Version = GetAssemblyVersionString() };
        }

        var json = File.ReadAllText(_localVersionManifestPath);
        return JsonSerializer.Deserialize<UpdateManifest>(json, _jsonOptions)
            ?? new UpdateManifest { Version = GetAssemblyVersionString() };
    }

    private async Task<UpdateManifest> DownloadUpdateManifestAsync(string manifestUrl)
    {
        var json = await UpdateHttpClient.GetStringAsync(manifestUrl);
        var manifest = JsonSerializer.Deserialize<UpdateManifest>(json, _jsonOptions);
        if (manifest is null)
        {
            throw new InvalidOperationException("The update manifest could not be parsed.");
        }

        if (string.IsNullOrWhiteSpace(manifest.Version))
        {
            throw new InvalidOperationException("The update manifest does not contain a version.");
        }

        if (string.IsNullOrWhiteSpace(manifest.PackageUrl))
        {
            throw new InvalidOperationException("The update manifest does not contain a packageUrl.");
        }

        return manifest;
    }

    private async Task BeginUpdateInstallAsync(UpdateManifest manifest)
    {
        if (!Directory.Exists(_updaterDirectory))
        {
            throw new InvalidOperationException($"Updater files were not found at {_updaterDirectory}.");
        }

        var updaterExecutable = ResolveUpdaterExecutablePath(_updaterDirectory);
        if (string.IsNullOrWhiteSpace(updaterExecutable))
        {
            throw new InvalidOperationException("Could not locate EntBot.Updater.exe in the updater directory.");
        }

        _isApplyingUpdate = true;
        SetStatus("Downloading Update");
        UpdateUiState();

        AppendLog($"[Update] Downloading package from: {manifest.PackageUrl}");

        var updateWorkspace = Path.Combine(Path.GetTempPath(), "EntBot", "updates", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(updateWorkspace);

        var packageZipPath = Path.Combine(updateWorkspace, "EntBot-update.zip");
        await DownloadFileAsync(manifest.PackageUrl, packageZipPath);

        if (!string.IsNullOrWhiteSpace(manifest.Sha256))
        {
            var actualHash = ComputeSha256(packageZipPath);
            if (!string.Equals(actualHash, manifest.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("The downloaded update package failed SHA-256 verification.");
            }

            AppendLog($"[Update] SHA-256 verified: {actualHash}");
        }

        var stagedUpdaterDirectory = Path.Combine(updateWorkspace, "updater");
        CopyDirectory(_updaterDirectory, stagedUpdaterDirectory);

        var stagedUpdaterExecutable = ResolveUpdaterExecutablePath(stagedUpdaterDirectory);
        if (string.IsNullOrWhiteSpace(stagedUpdaterExecutable))
        {
            throw new InvalidOperationException("The staged updater executable could not be found.");
        }

        var launchInfo = new UpdaterLaunchInfo
        {
            ParentProcessId = Environment.ProcessId,
            InstallDirectory = AppContext.BaseDirectory,
            PackageZipPath = packageZipPath,
            AppExecutablePath = GetCurrentApplicationPath(),
            RelaunchArguments = string.Empty,
            CleanupPaths = [updateWorkspace]
        };

        var launchInfoPath = Path.Combine(updateWorkspace, "update-session.json");
        File.WriteAllText(launchInfoPath, JsonSerializer.Serialize(launchInfo, _jsonOptions));

        var updaterStartInfo = new ProcessStartInfo
        {
            FileName = stagedUpdaterExecutable,
            Arguments = $"--session \"{launchInfoPath}\"",
            WorkingDirectory = stagedUpdaterDirectory,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        var updaterProcess = Process.Start(updaterStartInfo);
        if (updaterProcess is not null)
        {
            AppendLog("[Update] Updater launched. Closing EntBot to finish the update.");
        }
        else
        {
            throw new InvalidOperationException("The updater process could not be started.");
        }

        if (IsBotRunning)
        {
            await ShutdownBotAsync();
        }

        Application.Current.Shutdown();
    }

    private void UpdateUiState()
    {
        var botRunning = IsBotRunning;
        var busy = _isStopping || _isCheckingForUpdates || _isApplyingUpdate;
        var bandSelectionExists = BandModeListBox?.SelectedIndex >= 0;
        var bandEntryCount = BandModeListBox?.Items.Count ?? 0;
        var bandEditable = !botRunning && !busy;

        StartButton.IsEnabled = !botRunning && !busy;
        StopButton.IsEnabled = botRunning && !_isStopping && !_isApplyingUpdate;
        SaveButton.IsEnabled = !botRunning && !busy;
        ReloadButton.IsEnabled = !botRunning && !busy;
        CheckUpdatesButton.IsEnabled = !botRunning && !busy;
        ClearLogButton.IsEnabled = !botRunning && !busy;
        if (BandModeEnabledCheckBox is not null)
        {
            BandModeEnabledCheckBox.IsEnabled = bandEditable;
        }

        if (BandModeJsonTextBox is not null)
        {
            BandModeJsonTextBox.IsReadOnly = !bandEditable;
        }

        if (BandModeListBox is not null)
        {
            BandModeListBox.IsEnabled = bandEditable;
        }

        if (InsertBandTemplateButton is not null)
        {
            RemoveSelectedBandButton.IsEnabled = bandEditable && bandSelectionExists;
            MoveBandUpButton.IsEnabled = bandEditable && bandSelectionExists && BandModeListBox!.SelectedIndex > 0;
            MoveBandDownButton.IsEnabled = bandEditable && bandSelectionExists && BandModeListBox!.SelectedIndex >= 0 && BandModeListBox.SelectedIndex < bandEntryCount - 1;
            InsertBandTemplateButton.IsEnabled = bandEditable;
        }

        if (BandCharacterTextBox is not null)
        {
            BandCharacterTextBox.IsEnabled = bandEditable;
            BandUsernameTextBox.IsEnabled = bandEditable;
            BandPasswordTextBox.IsEnabled = bandEditable;
            BandPerformanceTypeComboBox.IsEnabled = bandEditable;
            BandDanceCommandComboBox.IsEnabled = bandEditable;
            BandMusicCommandComboBox.IsEnabled = bandEditable;
            BandSpecificFlourishEnabledCheckBox.IsEnabled = bandEditable;
            BandPetAutoCallEnabledCheckBox.IsEnabled = bandEditable;
            BandPetAutoGroupEnabledCheckBox.IsEnabled = bandEditable;
            BandAutoInviteOnTellCheckBox.IsEnabled = bandEditable;
            BandAdvertsEnabledCheckBox.IsEnabled = bandEditable;
            BandPetControlDeviceIdsTextBox.IsEnabled = bandEditable;
            AddBandEditorMemberButton.IsEnabled = bandEditable;
            SaveSelectedBandMemberButton.IsEnabled = bandEditable && bandSelectionExists;
            NewBandEditorButton.IsEnabled = bandEditable;
            ApplyBandEditorToMainButton.IsEnabled = bandEditable;
            UpdateBandEditorFlourishUiState();
        }
    }

    private void BandModeJsonTextBox_OnTextChanged(object sender, TextChangedEventArgs e)
    {
        RefreshBandModeEditorUi();
    }

    private void BandModeListBox_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        _isEditingNewBandMember = BandModeListBox.SelectedIndex < 0;
        RefreshBandModeSelectionDetails();
    }

    private void BandModeEnabledCheckBox_OnChanged(object sender, RoutedEventArgs e)
    {
        UpdateUiState();
    }

    private void SpecificFlourishEnabledCheckBox_OnChanged(object sender, RoutedEventArgs e)
    {
        UpdateFlourishUiState();
    }

    private void BandSpecificFlourishEnabledCheckBox_OnChanged(object sender, RoutedEventArgs e)
    {
        UpdateBandEditorFlourishUiState();
    }

    private void SetStatus(string status)
    {
        StatusTextBlock.Text = $"Status: {status}";
    }

    private void RefreshVersionText()
    {
        VersionTextBlock.Text = $"Version: {LoadLocalVersionManifest().Version}";
    }

    private void ToggleWindowState()
    {
        if (ResizeMode == ResizeMode.NoResize)
        {
            return;
        }

        WindowState = WindowState == WindowState.Maximized
            ? WindowState.Normal
            : WindowState.Maximized;
    }

    private void RefreshWindowStateUi()
    {
        if (MaximizeRestoreButton is null)
        {
            return;
        }

        var isMaximized = WindowState == WindowState.Maximized;
        MaximizeRestoreButton.Content = isMaximized ? "❐" : "□";
        MaximizeRestoreButton.ToolTip = isMaximized ? "Restore" : "Maximize";
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

        if (!string.IsNullOrWhiteSpace(_workerLogPath))
        {
            try
            {
                lock (_workerLogSync)
                {
                    File.AppendAllText(_workerLogPath, message + Environment.NewLine);
                }
            }
            catch
            {
                // ignore worker log file write failures
            }
        }
    }

    private void WorkerLogPollTimer_OnTick(object? sender, EventArgs e)
    {
        foreach (var state in _workerLogStates.ToArray())
        {
            DrainWorkerLog(state);
        }

        if (_workerLogStates.Count == 0)
        {
            _workerLogPollTimer.Stop();
        }
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

    private static Version ParseVersion(string? version)
    {
        if (Version.TryParse(version, out var parsedVersion))
        {
            return parsedVersion;
        }

        return new Version(0, 0, 0, 0);
    }

    private Version GetCurrentVersion()
    {
        return ParseVersion(LoadLocalVersionManifest().Version);
    }

    private string GetAssemblyVersionString()
    {
        return Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "1.0.0";
    }

    private string GetCurrentApplicationPath()
    {
        return Process.GetCurrentProcess().MainModule?.FileName
            ?? Path.Combine(AppContext.BaseDirectory, "EntBot.exe");
    }

    private (string FileName, string Arguments, string DisplayName) GetCurrentApplicationLaunchInfo()
    {
        var appExePath = Path.Combine(AppContext.BaseDirectory, "EntBot.exe");
        if (File.Exists(appExePath))
        {
            return (appExePath, string.Empty, appExePath);
        }

        var processPath = Environment.ProcessPath;
        if (!string.IsNullOrWhiteSpace(processPath))
        {
            if (string.Equals(Path.GetExtension(processPath), ".dll", StringComparison.OrdinalIgnoreCase))
            {
                return ("dotnet", $"\"{processPath}\"", $"dotnet {processPath}");
            }

            return (processPath, string.Empty, processPath);
        }

        var fallbackDllPath = Path.Combine(AppContext.BaseDirectory, "EntBot.dll");
        if (File.Exists(fallbackDllPath))
        {
            return ("dotnet", $"\"{fallbackDllPath}\"", $"dotnet {fallbackDllPath}");
        }

        var mainModulePath = Process.GetCurrentProcess().MainModule?.FileName;
        if (!string.IsNullOrWhiteSpace(mainModulePath))
        {
            return (mainModulePath, string.Empty, mainModulePath);
        }

        return (appExePath, string.Empty, appExePath);
    }

    private static async Task DownloadFileAsync(string url, string destinationPath)
    {
        using var response = await UpdateHttpClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();

        await using var sourceStream = await response.Content.ReadAsStreamAsync();
        await using var destinationStream = File.Create(destinationPath);
        await sourceStream.CopyToAsync(destinationStream);
    }

    private static string ComputeSha256(string filePath)
    {
        using var stream = File.OpenRead(filePath);
        var hash = SHA256.HashData(stream);
        return Convert.ToHexString(hash);
    }

    private static string ResolveUpdaterExecutablePath(string updaterDirectory)
    {
        var candidatePath = Path.Combine(updaterDirectory, "EntBot.Updater.exe");
        if (File.Exists(candidatePath))
        {
            return candidatePath;
        }

        candidatePath = Path.Combine(updaterDirectory, "EntBot.Updater");
        return File.Exists(candidatePath) ? candidatePath : string.Empty;
    }

    private static void CopyDirectory(string sourceDirectory, string destinationDirectory)
    {
        Directory.CreateDirectory(destinationDirectory);

        foreach (var sourcePath in Directory.GetDirectories(sourceDirectory, "*", SearchOption.AllDirectories))
        {
            var relativePath = Path.GetRelativePath(sourceDirectory, sourcePath);
            Directory.CreateDirectory(Path.Combine(destinationDirectory, relativePath));
        }

        foreach (var sourcePath in Directory.GetFiles(sourceDirectory, "*", SearchOption.AllDirectories))
        {
            var relativePath = Path.GetRelativePath(sourceDirectory, sourcePath);
            var destinationPath = Path.Combine(destinationDirectory, relativePath);
            var destinationPathDirectory = Path.GetDirectoryName(destinationPath);
            if (!string.IsNullOrWhiteSpace(destinationPathDirectory))
            {
                Directory.CreateDirectory(destinationPathDirectory);
            }

            File.Copy(sourcePath, destinationPath, overwrite: true);
        }
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

    private void StartBotProcess(string nodeExecutablePath, string settingsPath, string? logPrefix = null)
    {
        _usingExternalAppWorkers = false;
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
        startInfo.Environment["ENT_BOT_SETTINGS_FILE"] = settingsPath;
        if (!string.IsNullOrWhiteSpace(logPrefix))
        {
            startInfo.Environment["ENT_BOT_EXTERNAL_LOG_PREFIX"] = "true";
        }

        var process = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true
        };

        process.OutputDataReceived += (_, args) =>
        {
            if (!string.IsNullOrWhiteSpace(args.Data))
            {
                AppendLog(string.IsNullOrWhiteSpace(logPrefix) ? args.Data : $"{logPrefix}{args.Data}");
            }
        };

        process.ErrorDataReceived += (_, args) =>
        {
            if (!string.IsNullOrWhiteSpace(args.Data))
            {
                AppendLog(string.IsNullOrWhiteSpace(logPrefix) ? args.Data : $"{logPrefix}{args.Data}");
            }
        };

        process.Exited += (_, _) =>
        {
            var exitCode = process.ExitCode;
            _ = Dispatcher.InvokeAsync(() =>
            {
                AppendLog(
                    string.IsNullOrWhiteSpace(logPrefix)
                        ? $"[App] Bot exited with code {exitCode}."
                        : $"{logPrefix}[App] Bot exited with code {exitCode}."
                );
                _botProcesses.Remove(process);
                if (ReferenceEquals(_botProcess, process))
                {
                    _botProcess = _botProcesses.FirstOrDefault(active => !active.HasExited);
                }

                process.Dispose();

                if (_botProcesses.Count == 0)
                {
                    _botProcess = null;
                    _isStopping = false;
                    ClearWorkerSettingsFiles();
                    SetStatus("Stopped");
                    UpdateUiState();
                }
            });
        };

        if (!process.Start())
        {
            AppendLog("[App] Failed to start the bot process.");
            process.Dispose();
            return;
        }

        if (_botProcess is null)
        {
            _botProcess = process;
        }

        _botProcesses.Add(process);
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        SetStatus("Running");
        UpdateUiState();
    }

    private async Task StartBandProcessesAsync(string nodeExecutablePath, IReadOnlyList<JsonObject> entertainers)
    {
        _usingExternalAppWorkers = false;
        ClearWorkerLogFiles();
        for (var index = 0; index < entertainers.Count; index += 1)
        {
            var settingsPath = CreateBandWorkerSettingsFile(entertainers, index);
            var characterName = GetString(entertainers[index], "character", $"worker-{index + 1}");
            var logPrefix = $"[Band:{characterName}] ";
            StartBotProcess(nodeExecutablePath, settingsPath, logPrefix);

            if (index < entertainers.Count - 1)
            {
                await Task.Delay(3000);
            }
        }
    }

    private string CreateBandWorkerSettingsFile(IReadOnlyList<JsonObject> entertainers, int index)
    {
        var leaderCharacter = GetString(entertainers[0], "character");
        var entertainer = entertainers[index].DeepClone() as JsonObject ?? new JsonObject();
        if (index == 0)
        {
            entertainer["bandRole"] = "leader";
            entertainer["bandLeaderCharacter"] = string.Empty;
            entertainer["bandMemberCharacters"] = new JsonArray(
                entertainers
                    .Skip(1)
                    .Select(entry => JsonValue.Create(GetString(entry, "character")))
                    .Where(node => node is not null)
                    .ToArray()
            );
            entertainer["autoInviteOnTell"] = true;
        }
        else
        {
            entertainer["bandRole"] = "member";
            entertainer["bandLeaderCharacter"] = leaderCharacter;
            entertainer["bandMemberCharacters"] = new JsonArray();

            if (GetBool(entertainer, "petAutoCallEnabled", false))
            {
                entertainer["petAutoGroupEnabled"] = true;
                entertainer["petAutoGroupCommand"] = "/tellpet group";
                entertainer["petAutoGroupDelayMs"] = GetIntValue(entertainer, "petAutoGroupDelayMs", 3000);
            }

            if (entertainer["startupCommands"] is JsonArray existingStartupCommands)
            {
                entertainer["startupCommands"] = existingStartupCommands.DeepClone();
            }
            entertainer["startupCommandPauseMs"] = Math.Max(
                GetIntValue(entertainer, "startupCommandPauseMs", 3000),
                3000
            );
        }

        var payload = new JsonObject
        {
            ["entBot"] = new JsonObject
            {
                ["entertainers"] = new JsonArray(entertainer)
            },
            ["entBotWpf"] = new JsonObject
            {
                ["bandModeEnabled"] = false,
                ["bandModeDraft"] = string.Empty
            }
        };

        var tempDirectory = Path.Combine(Path.GetTempPath(), "entbot-wpf-band");
        Directory.CreateDirectory(tempDirectory);
        var filePath = Path.Combine(tempDirectory, $"entbot-band-{Process.GetCurrentProcess().Id}-{index + 1}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.json");
        File.WriteAllText(filePath, payload.ToJsonString(_jsonOptions));
        _workerSettingsPaths.Add(filePath);
        return filePath;
    }

    private void ClearWorkerSettingsFiles()
    {
        foreach (var filePath in _workerSettingsPaths)
        {
            try
            {
                if (File.Exists(filePath))
                {
                    File.Delete(filePath);
                }
            }
            catch
            {
                // ignore cleanup failures for temp settings files
            }
        }

        _workerSettingsPaths.Clear();
    }

    private void ClearWorkerLogFiles()
    {
        foreach (var filePath in _workerLogPaths)
        {
            try
            {
                if (File.Exists(filePath))
                {
                    File.Delete(filePath);
                }
            }
            catch
            {
                // ignore cleanup failures for temp worker logs
            }
        }

        _workerLogPaths.Clear();
        _workerLogStates.Clear();
        _workerLogPollTimer.Stop();
    }

    private static string CreateWorkerLogFilePath(int index, string characterName)
    {
        var tempDirectory = Path.Combine(Path.GetTempPath(), "entbot-wpf-band");
        Directory.CreateDirectory(tempDirectory);
        var safeCharacterName = string.IsNullOrWhiteSpace(characterName)
            ? $"worker-{index + 1}"
            : string.Concat(characterName.Select(ch => Path.GetInvalidFileNameChars().Contains(ch) ? '_' : ch));
        return Path.Combine(
            tempDirectory,
            $"entbot-worker-log-{Process.GetCurrentProcess().Id}-{index + 1}-{safeCharacterName}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.log");
    }

    private void DrainWorkerLog(WorkerLogState state)
    {
        try
        {
            if (!File.Exists(state.FilePath))
            {
                return;
            }

            using var stream = new FileStream(
                state.FilePath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            if (state.Position > stream.Length)
            {
                state.Position = 0;
            }

            stream.Seek(state.Position, SeekOrigin.Begin);
            using var reader = new StreamReader(stream);
            while (!reader.EndOfStream)
            {
                var line = reader.ReadLine();
                if (line is null)
                {
                    continue;
                }

                AppendLog($"[Band:{state.CharacterName}] {line}");
            }

            state.Position = stream.Position;
        }
        catch
        {
            // ignore worker log read failures while the file is still being written
        }
    }

    private static int GetIntValue(JsonObject source, string propertyName, int fallback)
    {
        try
        {
            return source[propertyName]?.GetValue<int>() ?? fallback;
        }
        catch
        {
            return fallback;
        }
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

    private static int ReadMillisecondsFromSeconds(TextBox textBox, string fieldName, int fallbackMilliseconds)
    {
        var raw = textBox.Text?.Trim() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(raw))
        {
            return fallbackMilliseconds;
        }

        if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds) &&
            !double.TryParse(raw, NumberStyles.Float, CultureInfo.CurrentCulture, out seconds))
        {
            throw new InvalidOperationException($"{fieldName} must be a number.");
        }

        if (seconds < 0)
        {
            throw new InvalidOperationException($"{fieldName} cannot be negative.");
        }

        return (int)Math.Round(seconds * 1000, MidpointRounding.AwayFromZero);
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

    private string BuildDanceCommand()
    {
        return $"/startdance {GetSelectedComboBoxTag(DanceCommandComboBox, DefaultDanceSelection)}";
    }

    private string BuildMusicCommand()
    {
        return $"/startmusic {GetSelectedComboBoxTag(MusicCommandComboBox, DefaultMusicSelection)}";
    }

    private string BuildBandDanceCommand()
    {
        return $"/startdance {GetSelectedComboBoxTag(BandDanceCommandComboBox, DefaultDanceSelection)}";
    }

    private string BuildBandMusicCommand()
    {
        return $"/startmusic {GetSelectedComboBoxTag(BandMusicCommandComboBox, DefaultMusicSelection)}";
    }

    private string? BuildFlourishCommand()
    {
        if (SpecificFlourishEnabledCheckBox.IsChecked != true)
        {
            return null;
        }

        return $"/flourish {GetSelectedComboBoxTag(FlourishCommandComboBox, DefaultFlourishSelection)}";
    }

    private string? BuildBandFlourishCommand()
    {
        if (BandSpecificFlourishEnabledCheckBox.IsChecked != true)
        {
            return null;
        }

        return $"/flourish {GetSelectedComboBoxTag(BandFlourishCommandComboBox, DefaultFlourishSelection)}";
    }

    private void UpdateFlourishUiState()
    {
        if (FlourishCommandComboBox is null || SpecificFlourishEnabledCheckBox is null)
        {
            return;
        }

        FlourishCommandComboBox.IsEnabled = SpecificFlourishEnabledCheckBox.IsChecked == true;
    }

    private void UpdateBandEditorFlourishUiState()
    {
        if (BandFlourishCommandComboBox is null || BandSpecificFlourishEnabledCheckBox is null)
        {
            return;
        }

        BandFlourishCommandComboBox.IsEnabled =
            BandSpecificFlourishEnabledCheckBox.IsEnabled && BandSpecificFlourishEnabledCheckBox.IsChecked == true;
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

    private void SelectBandPerformanceType(string value)
    {
        foreach (var item in BandPerformanceTypeComboBox.Items.OfType<ComboBoxItem>())
        {
            if (string.Equals(item.Content?.ToString(), value, StringComparison.OrdinalIgnoreCase))
            {
                BandPerformanceTypeComboBox.SelectedItem = item;
                return;
            }
        }

        BandPerformanceTypeComboBox.SelectedIndex = 0;
    }

    private static void SelectComboBoxItemByTag(ComboBox comboBox, string tagValue)
    {
        foreach (var item in comboBox.Items.OfType<ComboBoxItem>())
        {
            if (string.Equals(item.Tag?.ToString(), tagValue, StringComparison.OrdinalIgnoreCase))
            {
                comboBox.SelectedItem = item;
                return;
            }
        }

        if (comboBox.Items.Count > 0)
        {
            comboBox.SelectedIndex = 0;
        }
    }

    private string GetSelectedPerformanceType()
    {
        return (PerformanceTypeComboBox.SelectedItem as ComboBoxItem)?.Content?.ToString()?.Trim().ToLowerInvariant()
            ?? "dance";
    }

    private string GetSelectedBandPerformanceType()
    {
        return (BandPerformanceTypeComboBox.SelectedItem as ComboBoxItem)?.Content?.ToString()?.Trim().ToLowerInvariant()
            ?? "dance";
    }

    private static string GetSelectedComboBoxTag(ComboBox comboBox, string fallback)
    {
        return (comboBox.SelectedItem as ComboBoxItem)?.Tag?.ToString()?.Trim().ToLowerInvariant()
            ?? fallback;
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

    private static string GetSecondsString(JsonObject source, string propertyName, int fallbackMilliseconds)
    {
        try
        {
            var milliseconds = source[propertyName]?.GetValue<int>() ?? fallbackMilliseconds;
            return FormatSeconds(milliseconds);
        }
        catch
        {
            return FormatSeconds(fallbackMilliseconds);
        }
    }

    private static string FormatSeconds(int milliseconds)
    {
        var seconds = milliseconds / 1000d;
        return seconds.ToString("0.###", CultureInfo.InvariantCulture);
    }

    private static string ExtractCommandSelection(string command, string prefix, string fallback)
    {
        var normalized = command.Trim();
        if (normalized.StartsWith(prefix + " ", StringComparison.OrdinalIgnoreCase))
        {
            var suffix = normalized[prefix.Length..].Trim();
            return string.IsNullOrWhiteSpace(suffix) ? fallback : suffix.ToLowerInvariant();
        }

        return fallback;
    }

    private static string? ExtractFlourishSelection(string command)
    {
        var normalized = command.Trim();
        if (!normalized.StartsWith("/flourish ", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var suffix = normalized["/flourish".Length..].Trim().ToLowerInvariant();
        return suffix is "1" or "2" or "3" or "4" or "5" or "6" or "7" or "8"
            ? suffix
            : null;
    }

    private static string BuildBandModeListLabel(JsonNode? entertainerNode, int index)
    {
        if (entertainerNode is not JsonObject entertainer)
        {
            return $"{index + 1}. Entry {index + 1}";
        }

        var character = GetString(entertainer, "character", $"Entertainer {index + 1}");
        var username = GetString(entertainer, "username", "no account");
        var performanceType = GetString(entertainer, "performanceType", "dance");
        return $"{index + 1}. {character}  |  {username}  |  {performanceType}";
    }

    private static string BuildBandModeSelectionDetails(JsonObject entertainer)
    {
        var character = GetString(entertainer, "character", "Unknown character");
        var username = GetString(entertainer, "username", "Unknown account");
        var performanceType = GetString(entertainer, "performanceType", "dance");
        var dance = ExtractCommandSelection(GetString(entertainer, "danceCommand", "/startdance exotic4"), "/startdance", DefaultDanceSelection);
        var music = ExtractCommandSelection(GetString(entertainer, "musicCommand", "/startmusic starwars1"), "/startmusic", DefaultMusicSelection);
        var flourish = ExtractFlourishSelection(GetString(entertainer, "flourishCommand")) ?? "random";
        var petIds = GetArrayAsCommaSeparated(entertainer, "petControlDeviceIds", "none");
        var advertsEnabled = GetBool(entertainer, "advertsEnabled", false) ? "on" : "off";
        var petsEnabled = GetBool(entertainer, "petAutoCallEnabled", false) ? "on" : "off";

        return string.Join(
            Environment.NewLine,
            $"Character: {character}",
            $"Account: {username}",
            $"Performance type: {performanceType}",
            $"Dance selection: {dance}",
            $"Music selection: {music}",
            $"Flourish: {flourish}",
            $"Pet auto-call: {petsEnabled}",
            $"Pet IDs: {petIds}",
            $"Adverts: {advertsEnabled}"
        );
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

    private sealed class WorkerLogState
    {
        public WorkerLogState(string characterName, string filePath)
        {
            CharacterName = string.IsNullOrWhiteSpace(characterName) ? "unknown" : characterName;
            FilePath = filePath;
        }

        public string CharacterName { get; }
        public string FilePath { get; }
        public long Position { get; set; }
    }
}
