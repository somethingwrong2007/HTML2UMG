// Copyright (c) 2026 FPVSkyline. MIT License.
//
// Editor surface of the plugin: the HTML to UMG tab, the Tools/Window menu entries and
// the Html2UMG.* console commands.
//
// Registration rules (learned the hard way):
//   * everything is idempotent - Register() twice does not duplicate a menu entry;
//   * Unregister() removes every pointer we handed to an engine registry, because a
//     dangling console command or tab spawner crashes the next editor session;
//   * menus are contributed under an owner name so UToolMenus can drop them wholesale.

#include "Editor/Html2UMGEditor.h"

#include "Async/Async.h"
#include "Containers/Ticker.h"
#include "Editor/Html2UMGBlueprintLibrary.h"
#include "Editor/Html2UMGConverter.h"
#include "Editor/Html2UMGOptions.h"
#include "Editor/SHtml2UMGPanel.h"
#include "Framework/Application/SlateApplication.h"
#include "Framework/Docking/TabManager.h"
#include "HAL/IConsoleManager.h"
#include "Html2UMGLog.h"
#include "Misc/Paths.h"
#include "ToolMenus.h"
#include "UObject/Package.h"
#include "Widgets/Docking/SDockTab.h"

#define LOCTEXT_NAMESPACE "Html2UMGEditor"

namespace
{
	const FName Html2UMGPanelTabId(TEXT("Html2UMGPanel"));
	const FName Html2UMGToolMenuOwner(TEXT("Html2UMG"));
	const FName Html2UMGMenuSection(TEXT("Html2UMG"));
	const FName Html2UMGLegacyToolsMenu(TEXT("LevelEditor.MainMenu.Tools"));
	const FName Html2UMGLegacyWindowMenu(TEXT("LevelEditor.MainMenu.Window"));

	/** The live panel, so OpenPanel() can pre-fill a path on an already-open tab. */
	TWeakPtr<SHtml2UMGPanel> GPanelInstance;

	bool bIsRegistered = false;

	/** Console objects we own; must be unregistered explicitly on shutdown. */
	TArray<IConsoleObject*> GConsoleObjects;

	/** True once the tab spawner and menu entries exist. */
	bool bSlateSurfaceRegistered = false;

	/**
	 * Set when the plugin module started before Slate existed (LoadingPhase=Default can
	 * run earlier than FSlateApplication::Create), in which case registration finishes
	 * on the first tick instead of silently dropping the panel and the menus.
	 */
	FTSTicker::FDelegateHandle GSlateRetryHandle;

	// Defined further down in this file; forward declared so the deferred registration
	// helper can be placed next to the state it guards.
	TSharedRef<SDockTab> SpawnHtml2UMGPanelTab(const FSpawnTabArgs& SpawnArgs);
	void AddHtml2UMGMenuEntry(const FName MenuName);

	bool TryRegisterSlateSurface()
	{
		if (bSlateSurfaceRegistered)
		{
			return true;
		}
		if (!FSlateApplication::IsInitialized())
		{
			return false;
		}

		// ------------------------------------------------------------------ tab
		{
			const TSharedRef<FGlobalTabmanager>& TabManager = FGlobalTabmanager::Get();

			// A stale spawner survives plugin hot-reload; drop it before re-registering.
			if (TabManager->HasTabSpawner(Html2UMGPanelTabId))
			{
				TabManager->UnregisterNomadTabSpawner(Html2UMGPanelTabId);
			}

			TabManager->RegisterNomadTabSpawner(Html2UMGPanelTabId, FOnSpawnTab::CreateStatic(&SpawnHtml2UMGPanelTab))
				.SetDisplayName(LOCTEXT("Html2UMGTabTitle", "HTML to UMG"))
				.SetTooltipText(LOCTEXT("Html2UMGTabTooltip", "Convert HTML/CSS designs into native Widget Blueprints."))
				.SetAutoGenerateMenuEntry(false)
				.SetMenuType(ETabSpawnerMenuType::Hidden);
		}

		// ---------------------------------------------------------------- menus
		{
			UToolMenus::UnregisterOwner(Html2UMGToolMenuOwner);
			FToolMenuOwnerScoped OwnerScoped(Html2UMGToolMenuOwner);
			AddHtml2UMGMenuEntry(Html2UMGLegacyToolsMenu);
			AddHtml2UMGMenuEntry(Html2UMGLegacyWindowMenu);
		}

		bSlateSurfaceRegistered = true;
		return true;
	}

	bool TickSlateRegistration(float DeltaTime)
	{
		if (!bIsRegistered)
		{
			return false; // stop when the module went away first
		}
		return !TryRegisterSlateSurface(); // false removes the ticker
	}

	TSharedRef<SDockTab> SpawnHtml2UMGPanelTab(const FSpawnTabArgs& SpawnArgs)
	{
		TSharedRef<SHtml2UMGPanel> Panel = SNew(SHtml2UMGPanel);
		GPanelInstance = Panel;

		return SNew(SDockTab)
			.TabRole(ETabRole::NomadTab)
			.OnTabClosed_Lambda([](TSharedRef<SDockTab> ClosedTab)
			{
				GPanelInstance.Reset();
			})
			[
				Panel
			];
	}

	void LogImportMessages(const FH2UImportResult& Result)
	{
		for (const FH2UMessage& Message : Result.Messages)
		{
			const FString Severity = Message.Severity.IsEmpty() ? FString(TEXT("info")) : Message.Severity;
			if (Message.IsError())
			{
				UE_LOG(LogHtml2UMG, Error, TEXT("[%s] %s"), *Severity, *Message.Text);
			}
			else if (Severity.Equals(TEXT("warning"), ESearchCase::IgnoreCase))
			{
				UE_LOG(LogHtml2UMG, Warning, TEXT("[%s] %s"), *Severity, *Message.Text);
			}
			else
			{
				UE_LOG(LogHtml2UMG, Display, TEXT("[%s] %s"), *Severity, *Message.Text);
			}
		}

		UE_LOG(LogHtml2UMG, Display,
			TEXT("Html2UMG: %s - %d created, %d reused, %d properties, %d error(s), %d warning(s)%s%s"),
			Result.bSuccess ? TEXT("SUCCESS") : TEXT("FAILED"),
			Result.WidgetsCreated,
			Result.WidgetsReused,
			Result.PropertiesSet,
			Result.ErrorCount(),
			Result.WarningCount(),
			Result.BlueprintPath.IsEmpty() ? TEXT("") : TEXT(" -> "),
			*Result.BlueprintPath);
	}

	void LogReportLines(const FString& Text)
	{
		TArray<FString> Lines;
		Text.ParseIntoArrayLines(Lines, /*bCullEmpty=*/ true);
		for (const FString& Line : Lines)
		{
			UE_LOG(LogHtml2UMG, Display, TEXT("  %s"), *Line);
		}
	}

	void LogConvertResult(const FH2UConvertResult& Result)
	{
		if (Result.bSuccess)
		{
			UE_LOG(LogHtml2UMG, Display, TEXT("Html2UMG.Convert: OK"));
		}
		else
		{
			UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG.Convert: FAILED"));
		}
		LogReportLines(Result.ToText());
	}
}

namespace
{
	void AddHtml2UMGMenuEntry(const FName MenuName)
	{
		UToolMenu* Menu = UToolMenus::Get() ? UToolMenus::Get()->ExtendMenu(MenuName) : nullptr;
		if (Menu == nullptr)
		{
			return;
		}

		FToolMenuSection& Section = Menu->FindOrAddSection(Html2UMGMenuSection, LOCTEXT("Html2UMGSection", "HTML to UMG"));
		Section.AddMenuEntry(
			"Html2UMG.OpenPanel",
			LOCTEXT("Html2UMGMenuEntry", "HTML to UMG..."),
			LOCTEXT("Html2UMGMenuEntryTip", "Open the HTML to UMG panel: convert design.html and rebuild a Widget Blueprint."),
			FSlateIcon(),
			FUIAction(FExecuteAction::CreateLambda([]()
			{
				Html2UMGEditor::OpenPanel();
			})));
	}

	// ---- console commands ------------------------------------------------

	void ConsoleCommand_Open(const TArray<FString>& Args)
	{
		const FString InitialPath = Args.Num() > 0 ? Args[0] : FString();
		Html2UMGEditor::OpenPanel(InitialPath);
	}

	void ConsoleCommand_Convert(const TArray<FString>& Args)
	{
		if (Args.Num() < 1)
		{
			UE_LOG(LogHtml2UMG, Warning, TEXT("Usage: Html2UMG.Convert <html> [out.json]"));
			return;
		}

		FH2UConvertOptions ConvertOptions;
		ConvertOptions.HtmlFile = Args[0];
		if (Args.Num() > 1)
		{
			ConvertOptions.JsonFile = Args[1];
		}

		if (FSlateApplication::IsInitialized())
		{
			// Interactive editor: keep the game thread free, report when done.
			UE_LOG(LogHtml2UMG, Display, TEXT("Html2UMG.Convert: running in the background (%s)."), *ConvertOptions.HtmlFile);
			Async(EAsyncExecution::ThreadPool, [ConvertOptions]()
			{
				FH2UConvertResult ConvertResult;
				UHtml2UMGBlueprintLibrary::ConvertHtmlFileCore(ConvertOptions, ConvertResult);
				AsyncTask(ENamedThreads::GameThread, [ConvertResult]()
				{
					LogConvertResult(ConvertResult);
				});
			});
			return;
		}

		// Headless (-ExecCmds): stay synchronous so the json exists before we exit.
		FH2UConvertResult ConvertResult;
		UHtml2UMGBlueprintLibrary::ConvertHtmlFileCore(ConvertOptions, ConvertResult);
		LogConvertResult(ConvertResult);
	}

	void ConsoleCommand_Import(const TArray<FString>& Args)
	{
		if (Args.Num() < 1)
		{
			UE_LOG(LogHtml2UMG, Warning, TEXT("Usage: Html2UMG.Import <layout.json> [blueprintPath]"));
			return;
		}

		UHtml2UMGImportOptions* Options = NewObject<UHtml2UMGImportOptions>(GetTransientPackage());
		if (Args.Num() > 1)
		{
			Options->BlueprintPath = Args[1];
		}

		const FH2UImportResult Result = UHtml2UMGBlueprintLibrary::ImportLayoutFileCore(Args[0], Options->ToImportOptions());
		LogImportMessages(Result);
	}
}

namespace Html2UMGEditor
{
	void Register()
	{
		if (bIsRegistered)
		{
			UE_LOG(LogHtml2UMG, Verbose, TEXT("Html2UMG: editor surface already registered."));
			return;
		}
		bIsRegistered = true;

		// ------------------------------------------------------------------ tab
		if (FSlateApplication::IsInitialized())
		{
			const TSharedRef<FGlobalTabmanager>& TabManager = FGlobalTabmanager::Get();

			// A stale spawner survives plugin hot-reload; drop it before re-registering.
			if (TabManager->HasTabSpawner(Html2UMGPanelTabId))
			{
				TabManager->UnregisterNomadTabSpawner(Html2UMGPanelTabId);
			}

			TabManager->RegisterNomadTabSpawner(Html2UMGPanelTabId, FOnSpawnTab::CreateStatic(&SpawnHtml2UMGPanelTab))
				.SetDisplayName(LOCTEXT("Html2UMGTabTitle", "HTML to UMG"))
				.SetTooltipText(LOCTEXT("Html2UMGTabTooltip", "Convert HTML/CSS designs into native Widget Blueprints."))
				.SetAutoGenerateMenuEntry(false)
				.SetMenuType(ETabSpawnerMenuType::Hidden);
		}

		// ---------------------------------------------------------------- menus
		UToolMenus::UnregisterOwner(Html2UMGToolMenuOwner);
		{
			FToolMenuOwnerScoped OwnerScoped(Html2UMGToolMenuOwner);
			AddHtml2UMGMenuEntry(Html2UMGLegacyToolsMenu);
			AddHtml2UMGMenuEntry(Html2UMGLegacyWindowMenu);
		}

		// ----------------------------------------------------- console commands
		{
			IConsoleManager& ConsoleManager = IConsoleManager::Get();

			GConsoleObjects.Add(ConsoleManager.RegisterConsoleCommand(
				TEXT("Html2UMG.Open"),
				TEXT("Opens the HTML to UMG panel. Usage: Html2UMG.Open [path/to/design.html|layout.json]"),
				FConsoleCommandWithArgsDelegate::CreateStatic(&ConsoleCommand_Open)));

			GConsoleObjects.Add(ConsoleManager.RegisterConsoleCommand(
				TEXT("Html2UMG.Convert"),
				TEXT("Converts an HTML design into a layout json with the Node converter. Usage: Html2UMG.Convert <html> [out.json]"),
				FConsoleCommandWithArgsDelegate::CreateStatic(&ConsoleCommand_Convert)));

			GConsoleObjects.Add(ConsoleManager.RegisterConsoleCommand(
				TEXT("Html2UMG.Import"),
				TEXT("Imports a layout json into a Widget Blueprint. Usage: Html2UMG.Import <layout.json> [blueprintPath]"),
				FConsoleCommandWithArgsDelegate::CreateStatic(&ConsoleCommand_Import)));
		}

		UE_LOG(LogHtml2UMG, Log, TEXT("Html2UMG: editor surface registered (tab '%s', Tools/Window menus, 3 console commands)."),
			*Html2UMGPanelTabId.ToString());
	}

	void Unregister()
	{
		if (!bIsRegistered)
		{
			return;
		}
		bIsRegistered = false;

		// ----------------------------------------------------- console commands
		for (IConsoleObject* ConsoleObject : GConsoleObjects)
		{
			if (ConsoleObject != nullptr)
			{
				IConsoleManager::Get().UnregisterConsoleObject(ConsoleObject);
			}
		}
		GConsoleObjects.Reset();

		// ---------------------------------------------------------------- menus
		UToolMenus::UnregisterOwner(Html2UMGToolMenuOwner);

		// ------------------------------------------------------------------ tab
		if (FSlateApplication::IsInitialized())
		{
			const TSharedRef<FGlobalTabmanager>& TabManager = FGlobalTabmanager::Get();
			if (const TSharedPtr<SDockTab> LiveTab = TabManager->FindExistingLiveTab(FTabId(Html2UMGPanelTabId)))
			{
				LiveTab->RequestCloseTab();
			}
			TabManager->UnregisterNomadTabSpawner(Html2UMGPanelTabId);
		}

		GPanelInstance.Reset();
		UE_LOG(LogHtml2UMG, Log, TEXT("Html2UMG: editor surface unregistered."));
	}

	void OpenPanel(const FString& InitialFilePath)
	{
		if (!FSlateApplication::IsInitialized())
		{
			// Commandlet / headless: there is no tab to open, but the console commands and
			// the blueprint API still work.
			UE_LOG(LogHtml2UMG, Warning, TEXT("Html2UMG: no Slate application, cannot open the panel%s."),
				InitialFilePath.IsEmpty() ? TEXT("") : *FString::Printf(TEXT(" for '%s'"), *InitialFilePath));
			return;
		}

		if (!bIsRegistered)
		{
			Register();
		}

		const TSharedRef<FGlobalTabmanager>& TabManager = FGlobalTabmanager::Get();
		if (!TabManager->HasTabSpawner(Html2UMGPanelTabId))
		{
			UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG: the panel tab spawner is missing; registration failed."));
			return;
		}

		TabManager->TryInvokeTab(FTabId(Html2UMGPanelTabId));

		if (const TSharedPtr<SHtml2UMGPanel> Panel = GPanelInstance.Pin())
		{
			if (!InitialFilePath.IsEmpty())
			{
				Panel->SetInitialFilePath(InitialFilePath);
			}
		}
		else if (!InitialFilePath.IsEmpty())
		{
			UE_LOG(LogHtml2UMG, Warning, TEXT("Html2UMG: panel opened but its instance was not available for '%s'."), *InitialFilePath);
		}
	}
}

#undef LOCTEXT_NAMESPACE
