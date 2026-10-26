// Copyright (c) 2026 FPVSkyline. MIT License.

#include "Html2UMGTypes.h"

#include "Dom/JsonValue.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

int32 FH2UImportResult::ErrorCount() const
{
	int32 Count = 0;
	for (const FH2UMessage& Message : Messages)
	{
		if (Message.IsError())
		{
			++Count;
		}
	}
	return Count;
}

int32 FH2UImportResult::WarningCount() const
{
	int32 Count = 0;
	for (const FH2UMessage& Message : Messages)
	{
		if (Message.Severity.Equals(TEXT("warning"), ESearchCase::IgnoreCase))
		{
			++Count;
		}
	}
	return Count;
}

FString FH2UImportResult::ToText() const
{
	TStringBuilder<4096> Builder;
	for (const FH2UMessage& Message : Messages)
	{
		Builder.Append(Message.Severity.ToUpper());
		Builder.Append(TEXT(": "));
		Builder.Append(Message.Text);
		Builder.Append(TEXT("\n"));
	}
	return Builder.ToString();
}

namespace Html2UMG
{
	FString SanitizeWidgetName(const FString& InRaw)
	{
		FString Result;
		Result.Reserve(InRaw.Len());
		bool bLastWasUnderscore = false;
		for (int32 Index = 0; Index < InRaw.Len(); ++Index)
		{
			const TCHAR Char = InRaw[Index];
			const bool bLegal = FChar::IsAlnum(Char) || Char == TEXT('_');
			if (bLegal)
			{
				Result.AppendChar(Char);
				bLastWasUnderscore = false;
			}
			else if (!bLastWasUnderscore)
			{
				Result.AppendChar(TEXT('_'));
				bLastWasUnderscore = true;
			}
		}

		Result.TrimEndInline();
		while (Result.EndsWith(TEXT("_")))
		{
			Result.LeftChopInline(1);
		}

		if (Result.IsEmpty())
		{
			return TEXT("Widget");
		}

		if (FChar::IsDigit(Result[0]))
		{
			Result = FString(TEXT("W")) + Result;
		}

		return Result;
	}

	void MakeUniqueNames(TArray<FString>& Names)
	{
		TSet<FString> Used;
		Used.Reserve(Names.Num());
		for (FString& Name : Names)
		{
			if (!Used.Contains(Name))
			{
				Used.Add(Name);
				continue;
			}

			const FString Base = Name;
			int32 Suffix = 1;
			FString Candidate;
			do
			{
				Candidate = FString::Printf(TEXT("%s_%d"), *Base, Suffix++);
			}
			while (Used.Contains(Candidate));

			Name = Candidate;
			Used.Add(Name);
		}
	}
}

namespace
{
	constexpr int32 kMaxTreeDepth = 512;

	FString ReadStringField(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Field, const FString& Default = FString())
	{
		FString Value;
		if (Obj.IsValid() && Obj->TryGetStringField(Field, Value))
		{
			return Value;
		}
		return Default;
	}

	TSharedPtr<FJsonObject> ReadObjectField(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Field)
	{
		const TSharedPtr<FJsonObject>* Found = nullptr;
		if (Obj.IsValid() && Obj->TryGetObjectField(Field, Found) && Found)
		{
			return *Found;
		}
		return nullptr;
	}

	TSharedPtr<FH2UNode> ParseNode(const TSharedPtr<FJsonObject>& Obj, const FString& Context, TArray<FH2UMessage>& OutMessages, int32 Depth)
	{
		if (!Obj.IsValid())
		{
			OutMessages.Emplace(TEXT("error"), FString::Printf(TEXT("%s: node is not an object."), *Context));
			return nullptr;
		}

		if (Depth > kMaxTreeDepth)
		{
			OutMessages.Emplace(TEXT("error"), FString::Printf(TEXT("%s: tree deeper than %d, aborting."), *Context, kMaxTreeDepth));
			return nullptr;
		}

		TSharedPtr<FH2UNode> Node = MakeShared<FH2UNode>();

		if (!Obj->TryGetStringField(TEXT("name"), Node->Name) || Node->Name.IsEmpty())
		{
			OutMessages.Emplace(TEXT("error"), FString::Printf(TEXT("%s: node is missing a \"name\"."), *Context));
			return nullptr;
		}

		if (!Obj->TryGetStringField(TEXT("class"), Node->ClassName) || Node->ClassName.IsEmpty())
		{
			OutMessages.Emplace(TEXT("error"), FString::Printf(TEXT("%s: node '%s' is missing a \"class\"."), *Context, *Node->Name));
			return nullptr;
		}

		Obj->TryGetStringField(TEXT("source"), Node->Source);

		bool bVariable = true;
		if (Obj->TryGetBoolField(TEXT("variable"), bVariable))
		{
			Node->Variable = bVariable ? 1 : 0;
		}

		Node->Properties = ReadObjectField(Obj, TEXT("properties"));
		Node->Slot = ReadObjectField(Obj, TEXT("slot"));
		Node->Brush = ReadObjectField(Obj, TEXT("brush"));
		Obj->TryGetStringField(TEXT("namedSlot"), Node->NamedSlot);

		const TArray<TSharedPtr<FJsonValue>>* Children = nullptr;
		if (Obj->TryGetArrayField(TEXT("children"), Children) && Children)
		{
			Node->Children.Reserve(Children->Num());
			for (int32 Index = 0; Index < (*Children).Num(); ++Index)
			{
				const TSharedPtr<FJsonObject> ChildObject = (*Children)[Index]->AsObject();
				if (!ChildObject.IsValid())
				{
					OutMessages.Emplace(TEXT("error"), FString::Printf(TEXT("%s: child #%d of '%s' is not an object."), *Context, Index, *Node->Name));
					continue;
				}

				TSharedPtr<FH2UNode> ChildNode = ParseNode(ChildObject, FString::Printf(TEXT("%s/%s"), *Context, *Node->Name), OutMessages, Depth + 1);
				if (ChildNode.IsValid())
				{
					Node->Children.Add(ChildNode);
				}
			}
		}

		return Node;
	}

	void ParseAssetArray(const TSharedPtr<FJsonObject>& AssetsObject, const TCHAR* Field, TMap<FString, FH2UAssetRef>& OutAssets)
	{
		const TArray<TSharedPtr<FJsonValue>>* Entries = nullptr;
		if (!AssetsObject.IsValid() || !AssetsObject->TryGetArrayField(Field, Entries) || !Entries)
		{
			return;
		}

		for (const TSharedPtr<FJsonValue>& Entry : *Entries)
		{
			const TSharedPtr<FJsonObject> EntryObject = Entry->AsObject();
			if (!EntryObject.IsValid())
			{
				continue;
			}

			FH2UAssetRef Ref;
			if (!EntryObject->TryGetStringField(TEXT("key"), Ref.Key) || Ref.Key.IsEmpty())
			{
				continue;
			}
			EntryObject->TryGetStringField(TEXT("file"), Ref.File);
			EntryObject->TryGetStringField(TEXT("family"), Ref.Family);
			EntryObject->TryGetNumberField(TEXT("weight"), Ref.Weight);
			EntryObject->TryGetBoolField(TEXT("italic"), Ref.bItalic);
			OutAssets.Add(Ref.Key, Ref);
		}
	}
}

bool FH2ULayout::ResolveAssetFile(const FString& InRef, FString& OutAbsFile, FString& OutKey) const
{
	OutAbsFile.Reset();
	OutKey.Reset();

	if (InRef.IsEmpty())
	{
		return false;
	}

	FString Relative = InRef;
	if (InRef.StartsWith(TEXT("@")))
	{
		OutKey = InRef.RightChop(1);
		const FH2UAssetRef* Found = Textures.Find(OutKey);
		if (!Found)
		{
			Found = Fonts.Find(OutKey);
		}
		if (!Found || Found->File.IsEmpty())
		{
			return false;
		}
		Relative = Found->File;
	}

	if (FPaths::IsRelative(Relative))
	{
		OutAbsFile = FPaths::ConvertRelativePathToFull(FPaths::Combine(BaseDirectory, Relative));
	}
	else
	{
		OutAbsFile = Relative;
	}

	FPaths::NormalizeFilename(OutAbsFile);
	return IFileManager::Get().FileExists(*OutAbsFile);
}

static bool ParseLayoutDocument(const TSharedPtr<FJsonObject>& RootObject, const FString& InBaseDirectory, FH2ULayout& OutLayout, TArray<FH2UMessage>& OutMessages)
{
	if (!RootObject.IsValid())
	{
		OutMessages.Emplace(TEXT("error"), TEXT("layout: root is not a JSON object."));
		return false;
	}

	OutLayout.BaseDirectory = InBaseDirectory;

	RootObject->TryGetNumberField(TEXT("contractVersion"), OutLayout.ContractVersion);
	if (OutLayout.ContractVersion > 1)
	{
		OutMessages.Emplace(TEXT("warning"), FString::Printf(TEXT("layout: contractVersion %d is newer than the importer (1); unknown fields are ignored."), OutLayout.ContractVersion));
	}

	RootObject->TryGetStringField(TEXT("generator"), OutLayout.Generator);
	RootObject->TryGetStringField(TEXT("source"), OutLayout.SourcePath);
	RootObject->TryGetStringField(TEXT("blueprint"), OutLayout.BlueprintPath);
	const FString LegacyParentClass = ReadStringField(RootObject, TEXT("parentClass"));
	OutLayout.ParentClassPath = LegacyParentClass;

	if (const TSharedPtr<FJsonObject> ViewportObject = ReadObjectField(RootObject, TEXT("viewport")))
	{
		double Width = OutLayout.Viewport.X;
		double Height = OutLayout.Viewport.Y;
		ViewportObject->TryGetNumberField(TEXT("width"), Width);
		ViewportObject->TryGetNumberField(TEXT("height"), Height);
		OutLayout.Viewport = FVector2D(Width, Height);
	}

	if (const TSharedPtr<FJsonObject> AssetsObject = ReadObjectField(RootObject, TEXT("assets")))
	{
		ParseAssetArray(AssetsObject, TEXT("textures"), OutLayout.Textures);
		ParseAssetArray(AssetsObject, TEXT("fonts"), OutLayout.Fonts);
	}

	const TArray<TSharedPtr<FJsonValue>>* WarningArray = nullptr;
	if (RootObject->TryGetArrayField(TEXT("warnings"), WarningArray) && WarningArray)
	{
		for (const TSharedPtr<FJsonValue>& WarningValue : *WarningArray)
		{
			FString WarningText;
			if (WarningValue.IsValid() && WarningValue->TryGetString(WarningText))
			{
				OutLayout.Warnings.Add(WarningText);
			}
		}
	}

	const TSharedPtr<FJsonObject> RootNodeObject = ReadObjectField(RootObject, TEXT("root"));
	if (!RootNodeObject.IsValid())
	{
		OutMessages.Emplace(TEXT("error"), TEXT("layout: missing \"root\" node."));
		return false;
	}

	OutLayout.Root = ParseNode(RootNodeObject, TEXT("root"), OutMessages, 0);
	return OutLayout.Root.IsValid();
}

bool FH2ULayout::ParseFromString(const FString& JsonText, const FString& InBaseDirectory, FH2ULayout& OutLayout, TArray<FH2UMessage>& OutMessages)
{
	OutLayout = FH2ULayout();
	OutLayout.BaseDirectory = InBaseDirectory;

	TSharedPtr<FJsonObject> RootObject;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(JsonText);
	if (!FJsonSerializer::Deserialize(Reader, RootObject) || !RootObject.IsValid())
	{
		OutMessages.Emplace(TEXT("error"), FString::Printf(TEXT("layout: JSON parse failed: %s"), *Reader->GetErrorMessage()));
		return false;
	}

	return ParseLayoutDocument(RootObject, InBaseDirectory, OutLayout, OutMessages);
}

bool FH2ULayout::ParseFromFile(const FString& FilePath, FH2ULayout& OutLayout, TArray<FH2UMessage>& OutMessages)
{
	FString JsonText;
	if (!FFileHelper::LoadFileToString(JsonText, *FilePath))
	{
		OutMessages.Emplace(TEXT("error"), FString::Printf(TEXT("layout: cannot read '%s'."), *FilePath));
		return false;
	}

	const FString Directory = FPaths::GetPath(FPaths::ConvertRelativePathToFull(FilePath));
	const bool bParsed = ParseFromString(JsonText, Directory, OutLayout, OutMessages);
	OutLayout.BaseDirectory = Directory;
	return bParsed;
}
