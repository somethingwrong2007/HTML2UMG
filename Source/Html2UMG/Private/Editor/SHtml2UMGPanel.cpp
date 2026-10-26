// Copyright (c) 2026 FPVSkyline. MIT License.

#include "Editor/SHtml2UMGPanel.h"

#include "Async/Async.h"
#include "DesktopPlatformModule.h"
#include "Editor/Html2UMGBlueprintLibrary.h"
#include "Editor/Html2UMGConverter.h"
#include "Editor/Html2UMGOptions.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformProcess.h"
#include "Html2UMGLog.h"
#include "IDesktopPlatform.h"
#include "Importer/Html2UMGImporter.h"
#include "Misc/DateTime.h"
#include "Misc/Paths.h"
#include "Styling/AppStyle.h"
#include "Styling/CoreStyle.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SSeparator.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"

#define LOCTEXT_NAMESPACE "SHtml2UMGPanel"

namespace
{
	/** Keep the log view bounded; older lines are dropped in one go. */
	constexpr int32 MaxLogLines = 600;

	FString TrimPath(FString InPath)
	{
		InPath.TrimStartAndEndInline();
		InPath.TrimQuotesInline();
		return InPath;
	}

	FString DefaultJsonPathFor(const FString& HtmlPath)
	{
		if (HtmlPath.IsEmpty())
		{
			return FString();
		}
		const FString Directory = FPaths::GetPath(HtmlPath);
		const FString BaseName = FPaths::GetBaseFilename(HtmlPath);
		return FPaths::Combine(Directory.IsEmpty() ? FPaths::ProjectDir() : Directory, BaseName + TEXT(".json"));
	}
}

void SHtml2UMGPanel::Construct(const FArguments& InArgs)
{
	auto MakeLabel = [](const FText& Label) -> TSharedRef<SWidget>
	{
		return SNew(SBox)
			.WidthOverride(110.0f)
			.VAlign(VAlign_Center)
			[
				SNew(STextBlock).Text(Label)
			];
	};

	auto MakeCheckBox = [](const FText& Label, const TSharedPtr<SCheckBox>& CheckBox) -> TSharedRef<SWidget>
	{
		return SNew(SHorizontalBox)
			+ SHorizontalBox::Slot()
			.AutoWidth()
			.VAlign(VAlign_Center)
			[
				CheckBox.ToSharedRef()
			]
			+ SHorizontalBox::Slot()
			.AutoWidth()
			.VAlign(VAlign_Center)
			.Padding(4.0f, 0.0f, 18.0f, 0.0f)
			[
				SNew(STextBlock).Text(Label)
			];
	};

	ChildSlot
	[
		SNew(SBorder)
		.BorderImage(FAppStyle::Get().GetBrush("Brushes.Panel"))
		.Padding(12.0f)
		[
			SNew(SVerticalBox)

			// ---------------------------------------------------------- title
			+ SVerticalBox::Slot()
			.AutoHeight()
			.Padding(0.0f, 0.0f, 0.0f, 2.0f)
			[
				SNew(STextBlock)
				.Text(LOCTEXT("PanelTitle", "HTML to UMG"))
				.Font(FCoreStyle::GetDefaultFontStyle("Bold", 14))
			]

			+ SVerticalBox::Slot()
			.AutoHeight()
			.Padding(0.0f, 0.0f, 0.0f, 8.0f)
			[
				SNew(STextBlock)
				.Text(LOCTEXT("PanelSubtitle", "design.html -> layout.json (Node) -> Widget Blueprint"))
				.ColorAndOpacity(FSlateColor(FLinearColor(0.65f, 0.65f, 0.68f, 1.0f)))
			]

			// ------------------------------------------------------ source html
			+ SVerticalBox::Slot()
			.AutoHeight()
			.Padding(0.0f, 2.0f)
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				.Padding(0.0f, 0.0f, 8.0f, 0.0f)
				[
					MakeLabel(LOCTEXT("HtmlLabel", "Source HTML"))
				]
				+ SHorizontalBox::Slot()
				.FillWidth(1.0f)
				.VAlign(VAlign_Center)
				[
					SAssignNew(HtmlPathBox, SEditableTextBox)
					.HintText(LOCTEXT("HtmlHint", "D:/design/design.html"))
					.MinDesiredWidth(260.0f)
				]
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				.Padding(6.0f, 0.0f, 0.0f, 0.0f)
				[
					SNew(SButton)
					.Text(LOCTEXT("BrowseHtml", "Browse..."))
					.ToolTipText(LOCTEXT("BrowseHtmlTip", "Pick the source .html file."))
					.OnClicked(this, &SHtml2UMGPanel::OnBrowseHtmlClicked)
				]
			]

			// ------------------------------------------------------ layout json
			+ SVerticalBox::Slot()
			.AutoHeight()
			.Padding(0.0f, 2.0f)
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				.Padding(0.0f, 0.0f, 8.0f, 0.0f)
				[
					MakeLabel(LOCTEXT("JsonLabel", "Layout JSON"))
				]
				+ SHorizontalBox::Slot()
				.FillWidth(1.0f)
				.VAlign(VAlign_Center)
				[
					SAssignNew(JsonPathBox, SEditableTextBox)
					.HintText(LOCTEXT("JsonHint", "Empty = next to the html file"))
					.MinDesiredWidth(260.0f)
				]
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				.Padding(6.0f, 0.0f, 0.0f, 0.0f)
				[
					SNew(SButton)
					.Text(LOCTEXT("BrowseJson", "Browse..."))
					.ToolTipText(LOCTEXT("BrowseJsonTip", "Pick an existing layout .json to import."))
					.OnClicked(this, &SHtml2UMGPanel::OnBrowseJsonClicked)
				]
			]

			// -------------------------------------------------------- blueprint
			+ SVerticalBox::Slot()
			.AutoHeight()
			.Padding(0.0f, 2.0f)
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				.Padding(0.0f, 0.0f, 8.0f, 0.0f)
				[
					MakeLabel(LOCTEXT("BlueprintLabel", "Blueprint"))
				]
				+ SHorizontalBox::Slot()
				.FillWidth(1.0f)
				.VAlign(VAlign_Center)
				[
					SAssignNew(BlueprintPathBox, SEditableTextBox)
					.HintText(LOCTEXT("BlueprintHint", "/Game/UI/WBP_Design  (empty = from the layout json)"))
					.MinDesiredWidth(260.0f)
				]
			]

			// --------------------------------------------------------- viewport
			+ SVerticalBox::Slot()
			.AutoHeight()
			.Padding(0.0f, 2.0f)
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				.Padding(0.0f, 0.0f, 8.0f, 0.0f)
				[
					MakeLabel(LOCTEXT("ViewportLabel", "Viewport"))
				]
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				[
					SNew(SBox)
					.WidthOverride(80.0f)
					[
						SAssignNew(ViewportWidthBox, SEditableTextBox)
						.Text(LOCTEXT("DefaultWidth", "1920"))
					]
				]
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				.Padding(6.0f, 0.0f)
				[
					SNew(STextBlock).Text(LOCTEXT("Times", "x"))
				]
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				[
					SNew(SBox)
					.WidthOverride(80.0f)
					[
						SAssignNew(ViewportHeightBox, SEditableTextBox)
						.Text(LOCTEXT("DefaultHeight", "1080"))
					]
				]
			]

			// ---------------------------------------------------------- options
			+ SVerticalBox::Slot()
			.AutoHeight()
			.Padding(0.0f, 8.0f, 0.0f, 2.0f)
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				.Padding(0.0f, 0.0f, 8.0f, 0.0f)
				[
					MakeLabel(LOCTEXT("OptionsLabel", "Options"))
				]
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				[
					MakeCheckBox(LOCTEXT("ImportTextures", "Import textures"),
						SAssignNew(ImportTexturesCheck, SCheckBox).IsChecked(ECheckBoxState::Checked))
				]
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				[
					MakeCheckBox(LOCTEXT("ImportFonts", "Import fonts"),
						SAssignNew(ImportFontsCheck, SCheckBox).IsChecked(ECheckBoxState::Checked))
				]
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				[
					MakeCheckBox(LOCTEXT("ReimportInPlace", "Rebuild in place"),
						SAssignNew(ReimportInPlaceCheck, SCheckBox).IsChecked(ECheckBoxState::Checked))
				]
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				[
					MakeCheckBox(LOCTEXT("CompileBlueprint", "Compile"),
						SAssignNew(CompileCheck, SCheckBox).IsChecked(ECheckBoxState::Checked))
				]
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				[
					MakeCheckBox(LOCTEXT("SaveBlueprint", "Save"),
						SAssignNew(SaveCheck, SCheckBox).IsChecked(ECheckBoxState::Checked))
				]
			]

			+ SVerticalBox::Slot()
			.AutoHeight()
			.Padding(0.0f, 6.0f, 0.0f, 6.0f)
			[
				SNew(SSeparator)
			]

			// ---------------------------------------------------------- actions
			+ SVerticalBox::Slot()
			.AutoHeight()
			.Padding(0.0f, 2.0f)
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.Padding(0.0f, 0.0f, 6.0f, 0.0f)
				[
					SNew(SButton)
					.Text(LOCTEXT("ConvertButton", "Convert"))
					.ToolTipText(LOCTEXT("ConvertButtonTip", "Run the Node converter only: design.html -> layout.json."))
					.ContentPadding(FMargin(14.0f, 5.0f))
					.IsEnabled(this, &SHtml2UMGPanel::IsIdle)
					.OnClicked(this, &SHtml2UMGPanel::OnConvertClicked)
				]
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.Padding(0.0f, 0.0f, 6.0f, 0.0f)
				[
					SNew(SButton)
					.Text(LOCTEXT("ConvertImportButton", "Convert + Import"))
					.ToolTipText(LOCTEXT("ConvertImportButtonTip", "Convert the html, then build the widget blueprint from the result."))
					.ContentPadding(FMargin(14.0f, 5.0f))
					.IsEnabled(this, &SHtml2UMGPanel::IsIdle)
					.OnClicked(this, &SHtml2UMGPanel::OnConvertAndImportClicked)
				]
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.Padding(0.0f, 0.0f, 6.0f, 0.0f)
				[
					SNew(SButton)
					.Text(LOCTEXT("ImportButton", "Import JSON"))
					.ToolTipText(LOCTEXT("ImportButtonTip", "Import an existing layout.json without re-running the converter."))
					.ContentPadding(FMargin(14.0f, 5.0f))
					.IsEnabled(this, &SHtml2UMGPanel::IsIdle)
					.OnClicked(this, &SHtml2UMGPanel::OnImportJsonClicked)
				]
				+ SHorizontalBox::Slot()
				.FillWidth(1.0f)
				.VAlign(VAlign_Center)
				.Padding(12.0f, 0.0f)
				[
					SNew(STextBlock)
					.Text(this, &SHtml2UMGPanel::GetStatusText)
					.ColorAndOpacity(FSlateColor(FLinearColor(0.8f, 0.8f, 0.42f, 1.0f)))
				]
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				[
					SNew(SButton)
					.Text(LOCTEXT("ClearLogButton", "Clear Log"))
					.OnClicked(this, &SHtml2UMGPanel::OnClearLogClicked)
				]
			]

			// -------------------------------------------------------------- log
			+ SVerticalBox::Slot()
			.FillHeight(1.0f)
			.Padding(0.0f, 8.0f, 0.0f, 0.0f)
			[
				SNew(SBorder)
				.BorderBackgroundColor(FLinearColor(0.012f, 0.012f, 0.016f, 1.0f))
				.Padding(6.0f)
				[
					SAssignNew(LogScroll, SScrollBox)
					+ SScrollBox::Slot()
					[
						SAssignNew(LogLines, SVerticalBox)
					]
				]
			]
		]
	];

	AppendLog(TEXT("Ready. Pick a design.html, then use Convert + Import."), TEXT("dim"));
	if (!InArgs._InitialFilePath.IsEmpty())
	{
		SetInitialFilePath(InArgs._InitialFilePath);
	}
}

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

void SHtml2UMGPanel::ClearLog()
{
	if (LogLines.IsValid())
	{
		LogLines->ClearChildren();
	}
	LogLineCount = 0;
}

void SHtml2UMGPanel::AppendLog(const FString& InMessage, const FString& InSeverity)
{
	if (!IsInGameThread())
	{
		// Slate may only be touched from the game thread; hop over instead of asserting.
		const FString Message = InMessage;
		const FString Severity = InSeverity;
		TWeakPtr<SHtml2UMGPanel> WeakThis = StaticCastSharedRef<SHtml2UMGPanel>(AsShared());
		AsyncTask(ENamedThreads::GameThread, [WeakThis, Message, Severity]()
		{
			if (const TSharedPtr<SHtml2UMGPanel> Panel = WeakThis.Pin())
			{
				Panel->AppendLog(Message, Severity);
			}
		});
		return;
	}

	if (!LogLines.IsValid())
	{
		return;
	}

	if (LogLineCount >= MaxLogLines)
	{
		LogLines->ClearChildren();
		LogLineCount = 0;
	}

	FLinearColor Color(0.82f, 0.82f, 0.84f, 1.0f);
	if (InSeverity.Equals(TEXT("error"), ESearchCase::IgnoreCase))
	{
		Color = FLinearColor(1.0f, 0.36f, 0.33f, 1.0f);
	}
	else if (InSeverity.Equals(TEXT("warning"), ESearchCase::IgnoreCase))
	{
		Color = FLinearColor(1.0f, 0.78f, 0.30f, 1.0f);
	}
	else if (InSeverity.Equals(TEXT("success"), ESearchCase::IgnoreCase))
	{
		Color = FLinearColor(0.48f, 0.92f, 0.48f, 1.0f);
	}
	else if (InSeverity.Equals(TEXT("dim"), ESearchCase::IgnoreCase))
	{
		Color = FLinearColor(0.55f, 0.55f, 0.58f, 1.0f);
	}

	const FString Line = FString::Printf(TEXT("[%s] %s"), *FDateTime::Now().ToString(TEXT("%H:%M:%S")), *InMessage);

	LogLines->AddSlot()
		.AutoHeight()
		[
			SNew(STextBlock)
			.Text(FText::FromString(Line))
			.ColorAndOpacity(FSlateColor(Color))
			.AutoWrapText(true)
			.Font(FCoreStyle::GetDefaultFontStyle("Regular", 9))
		];
	++LogLineCount;

	if (LogScroll.IsValid())
	{
		LogScroll->ScrollToEnd();
	}
}

void SHtml2UMGPanel::LogLinesFromText(const FString& Text, const FString& Severity)
{
	TArray<FString> Lines;
	Text.ParseIntoArrayLines(Lines, /*bCullEmpty=*/ true);
	for (const FString& Line : Lines)
	{
		AppendLog(Line, Severity);
	}
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

void SHtml2UMGPanel::SetOperation(EOperation NewOperation)
{
	CurrentOperation = NewOperation;
}

FText SHtml2UMGPanel::GetStatusText() const
{
	switch (CurrentOperation)
	{
	case EOperation::Convert:
		return LOCTEXT("StatusConverting", "Converting (node)...");
	case EOperation::ConvertAndImport:
		return LOCTEXT("StatusConvertAndImport", "Converting, then importing...");
	case EOperation::Import:
		return LOCTEXT("StatusImporting", "Importing widget blueprint...");
	default:
		return LOCTEXT("StatusIdle", "Idle");
	}
}

FString SHtml2UMGPanel::GetHtmlPath() const
{
	return HtmlPathBox.IsValid() ? TrimPath(HtmlPathBox->GetText().ToString()) : FString();
}

FString SHtml2UMGPanel::GetJsonPath() const
{
	return JsonPathBox.IsValid() ? TrimPath(JsonPathBox->GetText().ToString()) : FString();
}

FString SHtml2UMGPanel::GetBlueprintPath() const
{
	return BlueprintPathBox.IsValid() ? TrimPath(BlueprintPathBox->GetText().ToString()) : FString();
}

FVector2D SHtml2UMGPanel::GetViewport() const
{
	const int32 Width = ViewportWidthBox.IsValid()
		? FMath::Clamp(FCString::Atoi(*ViewportWidthBox->GetText().ToString()), 64, 8192)
		: 1920;
	const int32 Height = ViewportHeightBox.IsValid()
		? FMath::Clamp(FCString::Atoi(*ViewportHeightBox->GetText().ToString()), 64, 8192)
		: 1080;
	return FVector2D(static_cast<double>(Width), static_cast<double>(Height));
}

bool SHtml2UMGPanel::IsChecked(const TSharedPtr<SCheckBox>& CheckBox, bool bFallback) const
{
	return CheckBox.IsValid() ? CheckBox->IsChecked() : bFallback;
}

void SHtml2UMGPanel::SetInitialFilePath(const FString& InPath)
{
	const FString Path = TrimPath(InPath);
	if (Path.IsEmpty())
	{
		return;
	}

	if (FPaths::GetExtension(Path).Equals(TEXT("json"), ESearchCase::IgnoreCase))
	{
		if (JsonPathBox.IsValid())
		{
			JsonPathBox->SetText(FText::FromString(Path));
		}
		return;
	}

	if (HtmlPathBox.IsValid())
	{
		HtmlPathBox->SetText(FText::FromString(Path));
	}
	if (JsonPathBox.IsValid() && JsonPathBox->GetText().ToString().TrimStartAndEnd().IsEmpty())
	{
		JsonPathBox->SetText(FText::FromString(DefaultJsonPathFor(Path)));
	}
}

void SHtml2UMGPanel::SuggestJsonPathFor(const FString& HtmlPath)
{
	if (JsonPathBox.IsValid() && JsonPathBox->GetText().ToString().TrimStartAndEnd().IsEmpty())
	{
		JsonPathBox->SetText(FText::FromString(DefaultJsonPathFor(HtmlPath)));
	}
}

// ---------------------------------------------------------------------------
// browse
// ---------------------------------------------------------------------------

FReply SHtml2UMGPanel::OnBrowseHtmlClicked()
{
	IDesktopPlatform* DesktopPlatform = FDesktopPlatformModule::Get();
	if (DesktopPlatform == nullptr)
	{
		AppendLog(TEXT("The desktop platform module is unavailable; type the path instead."), TEXT("error"));
		return FReply::Handled();
	}

	FString StartDirectory = FPaths::GetPath(GetHtmlPath());
	if (StartDirectory.IsEmpty() || !IFileManager::Get().DirectoryExists(*StartDirectory))
	{
		StartDirectory = FPaths::ProjectDir();
	}

	TArray<FString> SelectedFiles;
	const void* ParentWindowHandle = FSlateApplication::Get().FindBestParentWindowHandleForDialogs(nullptr);
	const bool bOpened = DesktopPlatform->OpenFileDialog(
		ParentWindowHandle,
		LOCTEXT("SelectHtmlTitle", "Select the source HTML").ToString(),
		StartDirectory,
		TEXT(""),
		TEXT("HTML files (*.html;*.htm)|*.html;*.htm|All files (*.*)|*.*"),
		EFileDialogFlags::None,
		SelectedFiles);

	if (bOpened && SelectedFiles.Num() > 0)
	{
		if (HtmlPathBox.IsValid())
		{
			HtmlPathBox->SetText(FText::FromString(SelectedFiles[0]));
		}
		SuggestJsonPathFor(SelectedFiles[0]);
		AppendLog(FString::Printf(TEXT("Source: %s"), *SelectedFiles[0]), TEXT("dim"));
	}
	return FReply::Handled();
}

FReply SHtml2UMGPanel::OnBrowseJsonClicked()
{
	IDesktopPlatform* DesktopPlatform = FDesktopPlatformModule::Get();
	if (DesktopPlatform == nullptr)
	{
		AppendLog(TEXT("The desktop platform module is unavailable; type the path instead."), TEXT("error"));
		return FReply::Handled();
	}

	FString StartDirectory = FPaths::GetPath(GetJsonPath());
	if (StartDirectory.IsEmpty() || !IFileManager::Get().DirectoryExists(*StartDirectory))
	{
		StartDirectory = FPaths::GetPath(GetHtmlPath());
	}
	if (StartDirectory.IsEmpty() || !IFileManager::Get().DirectoryExists(*StartDirectory))
	{
		StartDirectory = FPaths::ProjectDir();
	}

	TArray<FString> SelectedFiles;
	const void* ParentWindowHandle = FSlateApplication::Get().FindBestParentWindowHandleForDialogs(nullptr);
	const bool bOpened = DesktopPlatform->OpenFileDialog(
		ParentWindowHandle,
		LOCTEXT("SelectJsonTitle", "Select the layout JSON").ToString(),
		StartDirectory,
		TEXT(""),
		TEXT("Layout JSON (*.json)|*.json|All files (*.*)|*.*"),
		EFileDialogFlags::None,
		SelectedFiles);

	if (bOpened && SelectedFiles.Num() > 0)
	{
		if (JsonPathBox.IsValid())
		{
			JsonPathBox->SetText(FText::FromString(SelectedFiles[0]));
		}
		AppendLog(FString::Printf(TEXT("Layout: %s"), *SelectedFiles[0]), TEXT("dim"));
	}
	return FReply::Handled();
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

FReply SHtml2UMGPanel::OnConvertClicked()
{
	StartConvert(/*bImportAfterwards=*/ false);
	return FReply::Handled();
}

FReply SHtml2UMGPanel::OnConvertAndImportClicked()
{
	StartConvert(/*bImportAfterwards=*/ true);
	return FReply::Handled();
}

FReply SHtml2UMGPanel::OnImportJsonClicked()
{
	StartImport();
	return FReply::Handled();
}

FReply SHtml2UMGPanel::OnClearLogClicked()
{
	ClearLog();
	return FReply::Handled();
}

// ---------------------------------------------------------------------------
// convert (background) -> import (game thread)
// ---------------------------------------------------------------------------

void SHtml2UMGPanel::StartConvert(bool bImportAfterwards)
{
	if (!IsIdle())
	{
		AppendLog(TEXT("Still busy with the previous operation."), TEXT("warning"));
		return;
	}

	const FString HtmlPath = GetHtmlPath();
	if (HtmlPath.IsEmpty())
	{
		AppendLog(TEXT("No source html selected."), TEXT("error"));
		return;
	}
	if (!IFileManager::Get().FileExists(*HtmlPath))
	{
		AppendLog(FString::Printf(TEXT("Source html not found: %s"), *HtmlPath), TEXT("error"));
		return;
	}

	FH2UConvertOptions ConvertOptions;
	ConvertOptions.HtmlFile = FPaths::ConvertRelativePathToFull(HtmlPath);
	ConvertOptions.Viewport = GetViewport();
	ConvertOptions.TimeoutSeconds = ConvertTimeoutSeconds;
	ConvertOptions.BlueprintPath = GetBlueprintPath();

	const FString RequestedJson = GetJsonPath();
	ConvertOptions.JsonFile = RequestedJson.IsEmpty() ? DefaultJsonPathFor(HtmlPath) : RequestedJson;

	SetOperation(bImportAfterwards ? EOperation::ConvertAndImport : EOperation::Convert);
	AppendLog(FString::Printf(TEXT("Converting %s ..."), *ConvertOptions.HtmlFile), TEXT("info"));

	// Node runs on the thread pool; nothing in it touches a UObject.
	TWeakPtr<SHtml2UMGPanel> WeakThis = StaticCastSharedRef<SHtml2UMGPanel>(AsShared());
	Async(EAsyncExecution::ThreadPool, [WeakThis, ConvertOptions, bImportAfterwards]()
	{
		FH2UConvertResult ConvertResult;
		UHtml2UMGBlueprintLibrary::ConvertHtmlFileCore(ConvertOptions, ConvertResult);

		AsyncTask(ENamedThreads::GameThread, [WeakThis, ConvertResult, bImportAfterwards]()
		{
			if (const TSharedPtr<SHtml2UMGPanel> Panel = WeakThis.Pin())
			{
				Panel->OnConvertFinished(ConvertResult, bImportAfterwards);
			}
		});
	});
}

void SHtml2UMGPanel::OnConvertFinished(const FH2UConvertResult& ConvertResult, bool bImportAfterwards)
{
	SetOperation(EOperation::None);

	// The CLI streams its progress on stderr and only the summary on stdout, so stderr is
	// not automatically an error: severity follows the overall result.
	const FString StderrSeverity = ConvertResult.bSuccess ? FString(TEXT("dim")) : FString(TEXT("error"));
	if (!ConvertResult.StdOut.IsEmpty())
	{
		LogLinesFromText(ConvertResult.StdOut, TEXT("dim"));
	}
	if (!ConvertResult.StdErr.IsEmpty())
	{
		LogLinesFromText(ConvertResult.StdErr, StderrSeverity);
	}

	if (!ConvertResult.bSuccess)
	{
		AppendLog(FString::Printf(TEXT("Convert failed: %s"), *ConvertResult.Error), TEXT("error"));
		return;
	}

	AppendLog(FString::Printf(TEXT("Layout written: %s (%.2fs)"), *ConvertResult.JsonPath, ConvertResult.ElapsedSeconds), TEXT("success"));
	if (JsonPathBox.IsValid())
	{
		JsonPathBox->SetText(FText::FromString(ConvertResult.JsonPath));
	}

	if (bImportAfterwards)
	{
		StartImport();
	}
}

void SHtml2UMGPanel::StartImport()
{
	if (!IsIdle())
	{
		AppendLog(TEXT("Still busy with the previous operation."), TEXT("warning"));
		return;
	}
	if (!IsInGameThread())
	{
		AppendLog(TEXT("Import requested off the game thread; ignored."), TEXT("error"));
		return;
	}

	const FString JsonPath = GetJsonPath();
	if (JsonPath.IsEmpty())
	{
		AppendLog(TEXT("No layout json selected. Run Convert first or pick a .json."), TEXT("error"));
		return;
	}
	if (!IFileManager::Get().FileExists(*JsonPath))
	{
		AppendLog(FString::Printf(TEXT("Layout json not found: %s"), *JsonPath), TEXT("error"));
		return;
	}

	// The options object is only alive for this call; the importer copies everything it needs.
	UHtml2UMGImportOptions* Options = NewObject<UHtml2UMGImportOptions>(GetTransientPackage());
	Options->BlueprintPath = GetBlueprintPath();
	Options->bImportTextures = IsChecked(ImportTexturesCheck, true);
	Options->bImportFonts = IsChecked(ImportFontsCheck, true);
	Options->bReimportInPlace = IsChecked(ReimportInPlaceCheck, true);
	Options->bCompile = IsChecked(CompileCheck, true);
	Options->bSave = IsChecked(SaveCheck, true);
	Options->ViewportWidth = FMath::RoundToInt32(GetViewport().X);
	Options->ViewportHeight = FMath::RoundToInt32(GetViewport().Y);

	const FH2UImportOptions ImportOptions = Options->ToImportOptions();

	SetOperation(EOperation::Import);
	AppendLog(FString::Printf(TEXT("Importing %s ..."), *JsonPath), TEXT("info"));

	// Progress sink: the importer calls this synchronously on this (game) thread, so a
	// direct AppendLog is safe. Count the calls to avoid printing every message twice.
	TSharedPtr<int32> SinkCallCount = MakeShared<int32>(0);
	TWeakPtr<SHtml2UMGPanel> WeakThis = StaticCastSharedRef<SHtml2UMGPanel>(AsShared());

	const FH2UImportResult ImportResult = UHtml2UMGBlueprintLibrary::ImportLayoutFileCore(
		JsonPath,
		ImportOptions,
		[WeakThis, SinkCallCount](const FH2UMessage& Message)
		{
			++(*SinkCallCount);
			if (const TSharedPtr<SHtml2UMGPanel> Panel = WeakThis.Pin())
			{
				Panel->AppendLog(Message.Text, Message.Severity.IsEmpty() ? FString(TEXT("info")) : Message.Severity);
			}
		});

	// An importer that does not publish progress still returns its messages; show them
	// here so the log stays complete either way.
	if (*SinkCallCount == 0)
	{
		for (const FH2UMessage& Message : ImportResult.Messages)
		{
			AppendLog(Message.Text, Message.Severity.IsEmpty() ? FString(TEXT("info")) : Message.Severity);
		}
	}

	OnImportFinished(ImportResult);
}

void SHtml2UMGPanel::OnImportFinished(const FH2UImportResult& ImportResult)
{
	SetOperation(EOperation::None);

	if (!ImportResult.bSuccess)
	{
		AppendLog(TEXT("Import failed."), TEXT("error"));
	}

	AppendLog(FString::Printf(TEXT("Result: %d created, %d reused, %d properties, %d error(s), %d warning(s)."),
		ImportResult.WidgetsCreated,
		ImportResult.WidgetsReused,
		ImportResult.PropertiesSet,
		ImportResult.ErrorCount(),
		ImportResult.WarningCount()),
		ImportResult.bSuccess ? TEXT("success") : TEXT("error"));

	if (!ImportResult.BlueprintPath.IsEmpty())
	{
		AppendLog(FString::Printf(TEXT("Blueprint: %s"), *ImportResult.BlueprintPath), TEXT("info"));
		if (BlueprintPathBox.IsValid() && GetBlueprintPath().IsEmpty())
		{
			BlueprintPathBox->SetText(FText::FromString(ImportResult.BlueprintPath));
		}
	}
}

#undef LOCTEXT_NAMESPACE
